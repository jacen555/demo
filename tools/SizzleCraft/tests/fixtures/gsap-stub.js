/*
 * A no-op stand-in for GSAP, enough for the generated scene to initialise.
 *
 * write-build-html refuses to build without a local gsap (a local-first render must not
 * depend on a CDN), and an empty placeholder file is worse than no file: the generated
 * script block throws `gsap is not defined` on its first top-level call, so
 * window.__setFootageFrame is never defined and every footage assertion becomes
 * unreachable rather than false.
 *
 * Animation is deliberately inert — these tests assert that frames LOAD, not that they
 * tween. Every method returns a chainable inert tween so any call order survives.
 */
(function () {
  var tween = {
    kill: function () {},
    pause: function () { return tween; },
    play: function () { return tween; },
    resume: function () { return tween; },
    restart: function () { return tween; },
    seek: function () { return tween; },
    progress: function () { return tween; },
    // The scene drives every tween deterministically through __sch/__syncTweens, which call
    // totalDuration() and totalProgress(). Omitting the latter left the scene throwing on its
    // first trigger while __setFootageFrame was already defined — broken, but not in a way any
    // assertion keyed on that function could see.
    totalProgress: function () { return tween; },
    time: function () { return 0; },
    duration: function () { return 0; },
    totalDuration: function () { return 0; },
    invalidate: function () { return tween; },
    eventCallback: function () { return tween; },
    then: function (fn) { if (fn) fn(); return tween; },
  };

  function timeline() {
    var tl = Object.create(tween);
    tl.to = function () { return tl; };
    tl.from = function () { return tl; };
    tl.fromTo = function () { return tl; };
    tl.set = function () { return tl; };
    tl.add = function () { return tl; };
    tl.addLabel = function () { return tl; };
    tl.call = function () { return tl; };
    tl.getChildren = function () { return []; };
    return tl;
  }

  window.gsap = {
    to: function () { return tween; },
    from: function () { return tween; },
    fromTo: function () { return tween; },
    set: function () { return tween; },
    killTweensOf: function () {},
    getTweensOf: function () { return []; },
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
      progress: function () { return 0; },
      getChildren: function () { return []; },
      timeScale: function () { return 1; },
    },
    utils: {
      toArray: function (v) { return Array.prototype.slice.call(typeof v === 'string' ? document.querySelectorAll(v) : v || []); },
    },
  };
})();
