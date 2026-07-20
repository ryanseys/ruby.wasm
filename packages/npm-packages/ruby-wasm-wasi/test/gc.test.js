import { initRubyVM } from "./init";
import { describe, test, expect } from "vitest"

describe("GC integration", () => {
  test("Wrapped Ruby object should live until wrapper will be released", async () => {
    const vm = await initRubyVM();
    const run = vm.eval(`
      require "js"
      proc do |imports|
        imports.call(:mark_js_object_live, JS::Object.wrap(Object.new))
      end
    `);
    const livingObjects = new Set();
    run.call(
      "call",
      vm.wrap({
        mark_js_object_live: (object) => {
          livingObjects.add(object);
        },
      }),
    );
    vm.eval("GC.start");
    for (const object of livingObjects) {
      // Ensure that all objects are still alive
      object.call("itself");
    }
  });

  test("protect exported Ruby objects", async () => {
    function dropRbValue(value) {
      if (value.inner.drop) {
        value.inner.drop();
      } else if (global.gc) {
        global.gc();
      } else {
        console.warn("--expose-gc is not enabled. Skip GC test.")
      }
    }
    const vm = await initRubyVM();
    const initialGCCount = Number(vm.eval("GC.count").toString());
    const robj = vm.eval("$x = Object.new");
    const robjId = robj.call("object_id").toString();
    expect(robjId).not.toEqual("");

    vm.eval("GC.start");
    expect(robj.call("object_id").toString()).toBe(robjId);
    expect(Number(vm.eval("GC.count").toString())).toEqual(initialGCCount + 1);

    const robj2 = vm.eval("$x");
    vm.eval("GC.start");
    expect(robj2.call("object_id").toString()).toBe(robjId);

    const robj3 = robj2.call("itself");
    vm.eval("GC.start");
    expect(robj3.call("object_id").toString()).toBe(robjId);

    dropRbValue(robj);
    expect(robj2.call("object_id").toString()).toBe(robjId);
    expect(robj3.call("object_id").toString()).toBe(robjId);

    vm.eval("GC.start");
    expect(robj2.call("object_id").toString()).toBe(robjId);
    expect(robj3.call("object_id").toString()).toBe(robjId);

    dropRbValue(robj2);
    dropRbValue(robj3);

    vm.eval("GC.start");
  });

  test("protect objects having same hash values from GC", async () => {
    const vm = await initRubyVM();
    vm.eval(`
    class X
      def hash
        42
      end
      def eql?(other)
        true
      end
    end
    `);

    const o1 = vm.eval(`X.new`);
    const o2 = vm.eval(`X.new`);
    const o3 = vm.eval(`X.new`);
    vm.eval(`GC.start`);
    expect(o1.call("hash").toString()).toBe(o2.call("hash").toString());
    expect(o2.call("hash").toString()).toBe(o3.call("hash").toString());
  });

  // `Proc#to_js` (procToJsFunction in src/vm.ts) returns a plain JS function
  // that, on every call, wraps each argument AND the return value in a fresh
  // RbValue, and (before this file's fix) never released those intermediate
  // RbValues explicitly - they were left to whenever the JS engine happened
  // to GC the wrapper. `RbValue#release()` (+ the toJS()/toString()/
  // exportJsValue()/importJsValue() fixes) closes that specific gap, but
  // does NOT close this test: the retention traces one layer deeper, into
  // `RbValue#call()` itself (used by the trampoline to invoke the Ruby
  // Proc). The generated bindgen glue for `rb-funcallv-protect`
  // (src/bindgen/legacy/rb-abi-guest.js) inserts a *clone* of the receiver
  // into a fresh resource slab slot on every single call
  // (`this._resource0_slab.insert(obj0.clone())`), and nothing observed so
  // far drops that slot afterward - so every `.call(...)`, regardless of
  // arguments or return value, appears to retain roughly one slot on its
  // own. Explicitly releasing the wrapped arguments and the call's return
  // value (this file's fix) does not touch that receiver-clone slot at all,
  // since it isn't exposed to the caller of `.call()` - fixing it likely
  // needs either a leaner receiver-passing convention in the WIT interface
  // or an explicit drop of that clone once the underlying wasm call
  // returns. Any JS callback repeatedly invoking a Ruby proc (a DOM event
  // listener firing often, a requestAnimationFrame loop, a timer tick)
  // accumulates retained Ruby heap slots faster than V8's GC reclaims the
  // short-lived wrapper objects, so live slots grow roughly linearly with
  // invocation count and do NOT return to baseline after an explicit
  // Ruby-side GC.start.
  test("a JS-called Ruby proc should not permanently retain heap slots per invocation", async () => {
    const vm = await initRubyVM();
    const jsFn = vm.eval(`
      require "js"
      proc { |x| x }.to_js
    `).toJS();

    vm.eval("GC.start");
    const before = Number(vm.eval("GC.stat(:heap_live_slots)").toString());

    const ITERATIONS = 20000;
    for (let i = 0; i < ITERATIONS; i++) {
      jsFn(i);
    }

    vm.eval("GC.start");
    const afterGC = Number(vm.eval("GC.stat(:heap_live_slots)").toString());

    // A healthy proc->JS trampoline should not retain a meaningful fraction
    // of one live slot per call once GC has run - this asserts growth stays
    // under 10% of the call count as a generous bound. Today this fails: an
    // unpatched trampoline retains roughly 2 slots per call (~40000 for
    // 20000 iterations, i.e. ~100% growth relative to ITERATIONS).
    expect(afterGC - before).toBeLessThan(ITERATIONS * 0.1);
  });

  test("stop GC while having a sandwitched JS frame", async () => {
    const vm = await initRubyVM();
    const o = vm.eval(`
    require "js"

    JS.eval(<<~JS)
      return {
        takeVM(vm) {
          return vm.eval("GC.disable").toJS();
        }
      }
    JS
    `);
    const wasDisabled = o.call("takeVM", vm.wrap(vm));
    expect(wasDisabled.toJS()).toBe(true);
    // Ensure that GC is enabled back
    const isNotEnabledBack = vm.eval("GC.enable");
    expect(isNotEnabledBack.toJS()).toBe(false);

    // Re-start pending GC (including the incremental one)
    vm.eval("GC.start");

    // Disable GC before the nested call
    vm.eval("GC.disable");
    const o2 = vm.eval(`
    JS.eval(<<~JS)
      return {
        takeVM(vm) {
          return vm.eval("GC.disable").toJS();
        }
      }
    JS
    `);
    const wasDisabled2 = o2.call("takeVM", vm.wrap(vm));
    expect(wasDisabled2.toJS()).toBe(true);
    // Ensure that GC is still disabled because it was disabled before the nested call
    const isNotEnabledBack2 = vm.eval("GC.enable");
    expect(isNotEnabledBack2.toJS()).toBe(true);
  });
});
