/*
 * A GSAP stand-in whose tweens LAST as long as real ones, and still animate nothing.
 *
 * gsap-stub.js answers totalDuration() with 0, so every tween the scene schedules through
 * __sch ends a millisecond after it starts and the capture's motion guard
 * (__sigActiveTween) can never see one running. That is right for a test about what a
 * settled frame shows, and useless for a test about whether a frame is settled at all.
 * This stub reports GSAP's own duration arithmetic instead: `duration` (GSAP's default is
 * 0.5 s) times `repeat + 1`. A scheduled tween therefore occupies the same window of video
 * time a real one would.
 *
 * Styles are never touched, so what a frame shows is whatever the scene's classes say.
 *
 * This is a separate file rather than an edit to gsap-stub.js because gsapStubWithout()
 * derives its broken variants from that file's exact one-method-per-line format.
 */
(function () {
    function tween(vars) {
        var v = vars || {};
        var d = typeof v.duration === "number" ? v.duration : 0.5;
        var r = typeof v.repeat === "number" ? v.repeat : 0;
        var total = r < 0 ? 1e9 : d * (r + 1);
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
            progress: function () {
                return tw;
            },
            totalProgress: function () {
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
        return tw;
    }

    function timeline() {
        var tl = tween({ duration: 0 });
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
            return tween(vars);
        },
        from: function (targets, vars) {
            return tween(vars);
        },
        fromTo: function (targets, fromVars, toVars) {
            return tween(toVars);
        },
        set: function () {
            return tween({ duration: 0 });
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
            toArray: function (v) {
                return Array.prototype.slice.call(
                    typeof v === "string"
                        ? document.querySelectorAll(v)
                        : v || [],
                );
            },
        },
    };
})();
