// Onboarding submit helper — drop this into ANY intake front-end (athlete,
// coach, or branch) and it will POST the intake to the shared TOJ backend's
// /api/onboarding endpoint, then run the page's own success UX.
//
// Same-origin (tojcampaign.com / localhost): posts to "/api/onboarding".
// Cross-origin (a sibling Vercel site): posts to the absolute Render URL.
// The sibling site's origin must be in the backend CORS allowlist
// (server.js → CORS_ALLOWED_ORIGINS, or the ONBOARDING_CORS_ORIGINS env),
// OR the sibling should proxy /api/* to Render via its own vercel.json.
//
// USAGE — the page sets this before calling submit:
//   window.TOJ_ONBOARD = {
//     audience: 'athlete' | 'coach' | 'branch' | 'business' | 'creator',
//     branch:   'subject-medias' | 'coached-by-hooks' | ... (optional),
//     endpoint: 'https://...'      // optional override
//     showSuccess: function () { ... },   // page's own success screen
//     onError:     function (err) { ... } // optional
//   };
//   // then, at final submit, with the collected answers:
//   window.TOJ_ONBOARD.submit({
//     subject_name, is_minor, contact_email, contact_phone,
//     guardian_name, guardian_email, consent_level,  // c1..c4 for minors
//     payload: { ...all the intake answers... }
//   });

(function () {
  var RENDER = "https://toj-csv-app.onrender.com/api/onboarding";

  function defaultEndpoint() {
    try {
      var h = location.hostname || "";
      if (
        h === "localhost" ||
        h === "127.0.0.1" ||
        h.endsWith("tojcampaign.com")
      ) {
        return "/api/onboarding";
      }
    } catch (e) {}
    return RENDER;
  }

  window.TOJ_ONBOARD = window.TOJ_ONBOARD || {};

  window.TOJ_ONBOARD.submit = function (data) {
    var cfg = window.TOJ_ONBOARD;
    data = data || {};

    var body = {
      audience: cfg.audience,
      branch: cfg.branch || null,
      subject_name: data.subject_name || null,
      is_minor: data.is_minor === true,
      contact_email: data.contact_email || data.email || null,
      contact_phone: data.contact_phone || null,
      guardian_name: data.guardian_name || null,
      guardian_email: data.guardian_email || null,
      consent_level: data.consent_level || null,
      payload: data.payload || {},
      intake_version: data.intake_version || "v1",
      source: data.source || location.pathname,
    };

    if (!body.audience) {
      console.error("[onboarding-submit] missing window.TOJ_ONBOARD.audience");
    }
    // Client-side guard mirrors the server child-safety gate so the operator
    // gets an immediate, friendly message instead of a 400.
    if (body.is_minor && !body.guardian_email) {
      alert("For an athlete under 18, a parent/guardian email is required.");
      return;
    }

    var endpoint = cfg.endpoint || defaultEndpoint();
    var didFinish = false;
    var finish = function (result) {
      if (didFinish) return;
      didFinish = true;
      if (result && result.ok) {
        try {
          sessionStorage.setItem("toj-onboard-last-id", result.id || "");
        } catch (e) {}
      } else {
        console.error("[onboarding-submit] save failed:", result && result.error);
        if (typeof cfg.onError === "function") cfg.onError(result);
      }
      if (typeof cfg.showSuccess === "function") cfg.showSuccess(result);
    };

    var timer = setTimeout(function () {
      finish({ ok: false, error: "timeout" });
    }, 8000);

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return { ok: false, error: "bad_response" };
        });
      })
      .then(function (out) {
        clearTimeout(timer);
        finish(out);
      })
      .catch(function () {
        clearTimeout(timer);
        finish({ ok: false, error: "network" });
      });
  };
})();
