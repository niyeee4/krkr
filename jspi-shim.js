(function () {
  'use strict';

  var W = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : self);
  var REAL = {
    Suspending: W.WebAssembly && W.WebAssembly.Suspending,
    promising: W.WebAssembly && W.WebAssembly.promising,
    Instance: W.WebAssembly && W.WebAssembly.Instance,
    instantiate: W.WebAssembly && W.WebAssembly.instantiate,
    instantiateStreaming: W.WebAssembly && W.WebAssembly.instantiateStreaming,
    Memory: W.WebAssembly && W.WebAssembly.Memory
  };

  var hasNativeJspi = !!(REAL.Suspending && REAL.promising && REAL.Instance && REAL.instantiate);
  W.__jspiHasNative = hasNativeJspi;

  if (hasNativeJspi) {
    W.__jspiShimLoaded = true;
    return;
  }

  var STACK_SLOT_MAIN = 1024 * 1024;    // 1 MB for main instance (sufficient for deep VN async call stacks)
  var STACK_SLOT_WORKER = 512 * 1024;   // 512 KB per worker instance

  function State(imports, isWorker) {
    this.value = undefined;
    this.exports = null;
    this.isWorker = isWorker;
    this.exportCache = new WeakMap();
    this.pendingCalls = [];
    this.suspended = false;
    this.buffer = null;
    this.stackPtr = 0;

    var memory = null;
    if (imports) {
      if (imports.env && imports.env.memory) memory = imports.env.memory;
      else if (imports.wasi_snapshot_preview1 && imports.wasi_snapshot_preview1.memory) memory = imports.wasi_snapshot_preview1.memory;
    }
    this.memory = memory;
  }

  State.prototype.getMemory = function () {
    if (this.memory) return this.memory;
    if (this.exports && this.exports.memory) this.memory = this.exports.memory;
    else if (W.wasmMemory) this.memory = W.wasmMemory;
    else if (W.Module && W.Module.wasmMemory) this.memory = W.Module.wasmMemory;
    return this.memory;
  };

  State.prototype.getState = function () {
    if (this.exports && typeof this.exports.asyncify_get_state === 'function') {
      return this.exports.asyncify_get_state();
    }
    return 0;
  };

  State.prototype.assertNoneState = function () {
    var s = this.getState();
    if (s !== 0) throw new Error('Invalid async state ' + s + ', expected 0.');
  };

  State.prototype.ensureStack = function () {
    if (this.stackPtr !== 0) return this.stackPtr;
    return this.allocStack();
  };

  State.prototype.allocStack = function () {
    if (this.stackPtr !== 0) return this.stackPtr;
    var memory = this.getMemory();
    if (!memory) return 0;

    var slotSize = this.isWorker ? STACK_SLOT_WORKER : STACK_SLOT_MAIN;
    var totalSize = slotSize + 32;
    var ptr = 0;

    // 1. Prefer dynamic heap allocation via Emscripten malloc or memalign
    if (this.exports) {
      if (typeof this.exports.malloc === 'function') {
        try { ptr = this.exports.malloc(totalSize); } catch (e) { ptr = 0; }
      }
      if (!ptr && typeof this.exports.emscripten_builtin_memalign === 'function') {
        try { ptr = this.exports.emscripten_builtin_memalign(16, totalSize); } catch (e) { ptr = 0; }
      }
      if (!ptr && typeof this.exports._emscripten_stack_alloc === 'function') {
        try { ptr = this.exports._emscripten_stack_alloc(totalSize); } catch (e) { ptr = 0; }
      }
    }

    // 2. If malloc is not available or returned 0, grow memory safely
    if (!ptr && memory.buffer) {
      try {
        var neededPages = Math.ceil(totalSize / 65536);
        var oldPages = memory.grow(neededPages);
        if (oldPages !== -1 && oldPages !== undefined) {
          ptr = oldPages * 65536;
        }
      } catch (e) {
        ptr = 0;
      }
    }

    // 3. Fallback: place in upper safe region of current memory buffer
    if (!ptr && memory.buffer) {
      var curBytes = memory.buffer.byteLength;
      if (curBytes >= totalSize + 64) {
        ptr = (curBytes - totalSize - 16) & ~7;
      }
    }

    if (!ptr) {
      console.warn('[jspi-shim] Unable to allocate stack at this time; will retry on first async yield');
      return 0;
    }

    var alignedPtr = (ptr + 7) & ~7;
    var stackStart = alignedPtr + 8;
    var stackEnd = alignedPtr + 8 + slotSize;

    try {
      var headerView = new Int32Array(memory.buffer, alignedPtr, 2);
      headerView[0] = stackStart;
      headerView[1] = stackEnd;
    } catch (e) {
      console.warn('[jspi-shim] Error writing asyncify stack header:', e);
    }

    this.stackPtr = alignedPtr;
    this.buffer = memory.buffer;
    return this.stackPtr;
  };

  State.prototype.startUnwind = function (promise) {
    this.value = promise;
    this.ensureStack();
    if (this.exports && typeof this.exports.asyncify_start_unwind === 'function') {
      this.exports.asyncify_start_unwind(this.stackPtr);
    }
  };

  State.prototype.stopUnwind = function () {
    if (this.exports && typeof this.exports.asyncify_stop_unwind === 'function') {
      this.exports.asyncify_stop_unwind();
    }
  };

  State.prototype.startRewind = function () {
    this.ensureStack();
    if (this.exports && typeof this.exports.asyncify_start_rewind === 'function') {
      this.exports.asyncify_start_rewind(this.stackPtr);
    }
  };

  State.prototype.stopRewind = function () {
    if (this.exports && typeof this.exports.asyncify_stop_rewind === 'function') {
      this.exports.asyncify_stop_rewind();
    }
  };

  State.prototype.wrapImportFn = function (raw) {
    var self = this;
    return function () {
      var s = self.getState();
      if (s === 2) {
        self.stopRewind();
        return self.value;
      }
      self.assertNoneState();
      var r = raw.apply(this, arguments);
      if (r && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function') {
        self.startUnwind(r);
        return undefined;
      }
      return r;
    };
  };

  State.prototype.wrapExportFn = function (raw) {
    var cached = this.exportCache.get(raw);
    if (cached) return cached;
    var self = this;
    cached = async function () {
      if (self.getState() !== 0 || self.suspended) {
        var item = { fn: raw, args: arguments, self: this };
        item.promise = new Promise(function (res, rej) { item.resolve = res; item.reject = rej; });
        self.pendingCalls.push(item);
        return item.promise;
      }
      var result;
      for (;;) {
        result = raw.apply(this, arguments);
        if (self.getState() === 1) {
          self.stopUnwind();
          self.suspended = true;
          try {
            self.value = await self.value;
          } finally {
            self.suspended = false;
          }
          self.assertNoneState();
          self.drainPending();
          self.startRewind();
          continue;
        }
        self.drainPending();
        return result;
      }
    };
    this.exportCache.set(raw, cached);
    return cached;
  };

  State.prototype.drainPending = function () {
    while (this.pendingCalls.length) {
      var items = this.pendingCalls;
      this.pendingCalls = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var fn = this.wrapExportFn(item.fn);
        try {
          var res = fn.apply(item.self, item.args);
          item.resolve(res);
        } catch (e) {
          if (item.reject) item.reject(e);
          else item.resolve(Promise.reject(e));
        }
      }
    }
  };

  function wrapImportsObj(imports, state) {
    if (!imports) return imports;
    var out = {};
    for (var mod in imports) {
      var m = imports[mod];
      if (m && typeof m === 'object') {
        var mo = {};
        for (var name in m) {
          var f = m[name];
          mo[name] = typeof f === 'function' ? state.wrapImportFn(f) : f;
        }
        out[mod] = mo;
      } else {
        out[mod] = m;
      }
    }
    return out;
  }

  function wrapExportsObj(exports, state) {
    if (!exports) return exports;
    var out = {};
    for (var name in exports) {
      var f = exports[name];
      if (typeof f === 'function' && name.indexOf('asyncify_') !== 0) {
        out[name] = state.wrapExportFn(f);
      } else {
        out[name] = f;
      }
    }
    return out;
  }

  var instanceRegistry = new WeakMap();

  function makeInstance(realInstance, state) {
    var wrapped = Object.create(REAL.Instance ? REAL.Instance.prototype : Object.prototype);
    wrapped.exports = wrapExportsObj(realInstance.exports, state);
    instanceRegistry.set(wrapped, realInstance);
    state.exports = realInstance.exports;
    state.allocStack();
    return wrapped;
  }

  var currentState = null;

  function attachState(state) {
    currentState = state;
    W.__jspiState = state;
  }

  W.WebAssembly.Suspending = function (f) {
    if (typeof f === 'function') {
      f.isAsync = true;
    }
    return f;
  };

  W.WebAssembly.promising = function (f) {
    if (typeof f !== 'function') return f;
    if (currentState) {
      try { return currentState.wrapExportFn(f); } catch (e) {}
    }
    return async function () {
      if (currentState) {
        var wrapped = currentState.wrapExportFn(f);
        return wrapped.apply(this, arguments);
      }
      return f.apply(this, arguments);
    };
  };

  W.WebAssembly.Instance = function (module, imports) {
    var state = new State(imports, typeof WorkerGlobalScope !== 'undefined' || !!(W.ENVIRONMENT_IS_WORKER));
    attachState(state);
    var wrappedImports = wrapImportsObj(imports, state);
    var real = new REAL.Instance(module, wrappedImports);
    return makeInstance(real, state);
  };

  try {
    if (REAL.Instance && REAL.Instance.prototype) {
      W.WebAssembly.Instance.prototype = Object.create(REAL.Instance.prototype);
      W.WebAssembly.Instance.prototype.constructor = W.WebAssembly.Instance;
    }
  } catch (e) {
    console.warn('[jspi-shim] Instance prototype warning:', e);
  }
  W.WebAssembly.Instance.OriginalInstance = REAL.Instance;
  W.WebAssembly.OriginalInstance = REAL.Instance;

  W.WebAssembly.instantiate = function (arg, imports) {
    var state = new State(imports, typeof WorkerGlobalScope !== 'undefined' || !!(W.ENVIRONMENT_IS_WORKER));
    attachState(state);
    var wrappedImports = wrapImportsObj(imports, state);
    return REAL.instantiate(arg, wrappedImports).then(function (result) {
      if (result instanceof REAL.Instance) {
        return makeInstance(result, state);
      }
      if (result && result.instance) {
        var wrapped = makeInstance(result.instance, state);
        return { instance: wrapped, module: result.module };
      }
      return result;
    });
  };

  W.WebAssembly.instantiateStreaming = function (arg, imports) {
    var state = new State(imports, typeof WorkerGlobalScope !== 'undefined' || !!(W.ENVIRONMENT_IS_WORKER));
    attachState(state);
    var wrappedImports = wrapImportsObj(imports, state);
    if (typeof REAL.instantiateStreaming === 'function') {
      return REAL.instantiateStreaming(arg, wrappedImports).then(function (result) {
        if (result && result.instance) {
          var wrapped = makeInstance(result.instance, state);
          return { instance: wrapped, module: result.module };
        }
        return result;
      }).catch(function (err) {
        return Promise.resolve(arg).then(function (res) {
          return res instanceof Response ? res.arrayBuffer() : res;
        }).then(function (bytes) {
          return W.WebAssembly.instantiate(bytes, imports);
        });
      });
    } else {
      return Promise.resolve(arg).then(function (res) {
        return res instanceof Response ? res.arrayBuffer() : res;
      }).then(function (bytes) {
        return W.WebAssembly.instantiate(bytes, imports);
      });
    }
  };

  W.__jspiShimLoaded = true;
})();
