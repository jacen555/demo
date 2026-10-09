/*
 * A GSAP stand-in that renders OPACITY, and nothing else.
 *
 * gsap-stub.js and gsap-timed-stub.js never touch styles, so a test can see which classes
 * a frame has but not what opacity it shows. This stub interpolates `opacity` linearly
 * between a tween's start and end values, at whatever totalProgress the scene's
 * __syncTweens sets. It follows the GSAP behaviour the runtime depends on:
 *   - fromTo renders its from values when it is created (GSAP's immediateRender);
 *   - a missing from value, and every `to` start value, is read from the element's
 *     computed opacity when the tween first renders;
 *   - a function from value is called as (index, target, targets);
 *   - clearProps removes the named inline properties when a tween completes, and at once
 *     in gsap.set.
 * The durations are GSAP's own arithmetic, as in gsap-timed-stub.js, so the motion guard
 * sees each tween run for as long as a real one would. Transforms, positions and stroke
 * offsets stay inert, and there is no easing: a test may assert where an opacity is, and
 * which way it is heading, but not the curve it follows.
 */
(function () {
  function targetsOf(t) {
    if (!t) return [];
    if (typeof t === "string")
      return Array.prototype.slice.call(document.querySelectorAll(t));
    if (t.nodeType === 1) return [t];
    return Array.prototype.slice.call(t);
  }

  function clearProps(els, spec) {
    var props =
      spec === true || spec === "all"
        ? ["opacity", "transform"]
        : String(spec).split(",");
    els.forEach(function (el) {
      props.forEach(function (p) {
        el.style.removeProperty(
          p.trim().replace(/[A-Z]/g, function (c) {
            return "-" + c.toLowerCase();
          }),
        );
      });
    });
  }

  function tween(targets, fromVars, toVars) {
    var els = targetsOf(targets);
    var v = toVars || {};
    var d = typeof v.duration === "number" ? v.duration : 0.5;
    var r = typeof v.repeat === "number" ? v.repeat : 0;
    var total = r < 0 ? 1e9 : d * (r + 1);
    var animates = typeof v.opacity === "number";
    var start = null;

    function init() {
      start = els.map(function (el, i) {
        var f = fromVars ? fromVars.opacity : undefined;
        if (typeof f === "function") f = f(i, el, els);
        return typeof f === "number"
          ? f
          : parseFloat(getComputedStyle(el).opacity);
      });
    }
    function render(p) {
      if (!animates) return;
      if (!start) init();
      els.forEach(function (el, i) {
        el.style.opacity = String(start[i] + (v.opacity - start[i]) * p);
      });
      if (p >= 1 && v.clearProps) clearProps(els, v.clearProps);
    }

    var tw = {
      kill: function () {},
      pause: function () {
        return tw;
      },
      play: function () {
        return tw;
      },
      resume: function () {
        return tw;
      },
      restart: function () {
        return tw;
      },
      seek: function () {
        return tw;
      },
      progress: function (p) {
        if (typeof p === "number") render(Math.max(0, Math.min(1, p)));
        return tw;
      },
      totalProgress: function (p) {
        if (typeof p === "number") render(Math.max(0, Math.min(1, p)));
        return tw;
      },
      time: function () {
        return 0;
      },
      duration: function () {
        return d;
      },
      totalDuration: function () {
        return total;
      },
      invalidate: function () {
        return tw;
      },
      eventCallback: function () {
        return tw;
      },
      then: function (fn) {
        if (fn) fn();
        return tw;
      },
    };
    if (fromVars) render(0);
    return tw;
  }

  function timeline() {
    var tl = tween(null, null, { duration: 0 });
    tl.to = function () {
      return tl;
    };
    tl.from = function () {
      return tl;
    };
    tl.fromTo = function () {
      return tl;
    };
    tl.set = function () {
      return tl;
    };
    tl.add = function () {
      return tl;
    };
    tl.addLabel = function () {
      return tl;
    };
    tl.call = function () {
      return tl;
    };
    tl.getChildren = function () {
      return [];
    };
    return tl;
  }

  window.gsap = {
    to: function (targets, vars) {
      return tween(targets, null, vars);
    },
    from: function (targets, vars) {
      return tween(targets, null, { duration: vars && vars.duration });
    },
    fromTo: function (targets, fromVars, toVars) {
      return tween(targets, fromVars || {}, toVars);
    },
    set: function (targets, vars) {
      var els = targetsOf(targets);
      if (vars && typeof vars.opacity === "number")
        els.forEach(function (el) {
          el.style.opacity = String(vars.opacity);
        });
      if (vars && vars.clearProps) clearProps(els, vars.clearProps);
      return tween(null, null, { duration: 0 });
    },
    killTweensOf: function () {},
    getTweensOf: function () {
      return [];
    },
    registerPlugin: function () {},
    defaults: function () {},
    config: function () {},
    timeline: timeline,
    ticker: {
      fps: function () {},
      add: function () {},
      remove: function () {},
      lagSmoothing: function () {},
    },
    globalTimeline: {
      pause: function () {},
      play: function () {},
      progress: function () {
        return 0;
      },
      getChildren: function () {
        return [];
      },
      timeScale: function () {
        return 1;
      },
    },
    utils: {
      toArray: targetsOf,
    },
  };
})();
