// Foundation Score intake submit helper.
//
// Each intake page defines a global `submitIntake()` that today shows a
// success screen and clears sessionStorage. This helper wraps that flow so
// the intake also POSTs to the owned Express backend before showing success.
//
// The page must set BEFORE this script runs:
//   window.TOJ_INTAKE = {
//     vertical: 'personal-brand' | 'nonprofit' | 'authority',
//     storageKey: 'toj-fs-personal-brand',       // sessionStorage key
//     showSuccess: () => { ... },                // page's own success UX
//   };
// Then the page's Submit button calls window.TOJ_INTAKE.submit() instead of
// its old inline submitIntake().

(function () {
  var ENDPOINT = "https://app.tojcampaign.com/api/intake/foundation-score";
  if (
    typeof window !== "undefined" &&
    /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
  ) {
    ENDPOINT = window.location.origin + "/api/intake/foundation-score";
  }

  function readSessionData(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "{}");
    } catch {
      return {};
    }
  }

  function post(vertical, payload) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vertical: vertical,
        intake_version: "v1",
        payload: payload,
        contact_email: payload.contact_email || payload.email,
        operator_name: payload.brand_name || payload.operator_name,
        business_name: payload.business_name,
      }),
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: "bad_response" };
      });
    });
  }

  window.TOJ_INTAKE = window.TOJ_INTAKE || {};

  // The page calls this at final submit.
  window.TOJ_INTAKE.submit = function () {
    var cfg = window.TOJ_INTAKE;
    if (!cfg.vertical || !cfg.storageKey || typeof cfg.showSuccess !== "function") {
      console.error("[intake-submit] misconfigured — page must set window.TOJ_INTAKE.{vertical, storageKey, showSuccess}");
      // Fallback: still try to move forward so the user isn't stuck.
      if (typeof cfg.showSuccess === "function") cfg.showSuccess();
      return;
    }

    var payload = readSessionData(cfg.storageKey);
    if (!payload.contact_email || !payload.contact_phone) {
      alert("Please add your email and phone before submitting.");
      return;
    }

    // Show success optimistically after the POST returns (or times out).
    var didFinish = false;
    var finish = function (result) {
      if (didFinish) return;
      didFinish = true;
      if (result && result.ok) {
        // Success — remember the ID for reference and clear the draft.
        try {
          sessionStorage.setItem("toj-fs-last-id", result.foundation_score_id || "");
          sessionStorage.removeItem(cfg.storageKey);
        } catch {}
      } else {
        // Save-failed path: keep the draft so the operator doesn't lose the work.
        console.error("[intake-submit] save failed:", result && result.error);
        var msg =
          "We captured your intake, but there was a hiccup saving it to our system. " +
          "Your answers are held locally. Please email hello@tojcampaign.com and we'll grab them manually.";
        try {
          var el = document.getElementById("save-warning");
          if (el) {
            el.textContent = msg;
            el.style.display = "block";
          } else {
            alert(msg);
          }
        } catch {}
      }
      cfg.showSuccess();
    };

    // 8 second timeout — long enough for a slow network, short enough
    // that a broken backend doesn't block the UX.
    var timer = setTimeout(function () {
      finish({ ok: false, error: "timeout" });
    }, 8000);

    post(cfg.vertical, payload)
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
