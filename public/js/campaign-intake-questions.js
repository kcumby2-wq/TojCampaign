// Campaign intake — the 31 questions TOJ asks before quoting or building a
// custom campaign, in the same order and numbering as the "TOJ Agency Brief
// and Campaign Intake" doc. One source of truth:
//
//   public/intake.html            renders the form from this list
//   public/admin/intake-crm.html  shows the answers and "Copy for TOJ"
//   tests/campaign-intake.test.js keeps the numbering and rules honest
//
// Each question has one or more fields. Field keys are what the form saves in
// the intake payload (onboarding_intakes.payload). Privacy: no field asks for
// a minor's name. Question 15 asks for roles and releases, never names.

(function (root) {
  "use strict";

  var VERSION = "campaign-v1";

  var STEPS = [
    { n: 1, topic: "Goal", short: "Goal", title: "What's the campaign", accent: "for?", desc: "What you're selling, the one thing people should do, and the dates that matter." },
    { n: 2, topic: "Audience", short: "Audience", title: "Who is it", accent: "for?", desc: "Who we're talking to, who pays, and what they believe today." },
    { n: 3, topic: "Brand", short: "Brand", title: "How should it", accent: "look and sound?", desc: "The exact names, files and words that make it yours." },
    { n: 4, topic: "Proof", short: "Proof", title: "What can we", accent: "show?", desc: "Results, partners and people we have permission to put on screen." },
    { n: 5, topic: "Assets", short: "Assets", title: "What do we have", accent: "to work with?", desc: "Footage and photos that already exist, shoots we'd need, and music." },
    { n: 6, topic: "Funnel", short: "Funnel", title: "Where does", accent: "it lead?", desc: "Where the click goes and what happens after it." },
    { n: 7, topic: "Channels and scope", short: "Scope", title: "Where, how much,", accent: "and by when?", desc: "Formats, ads, deliverables and budget." },
    { n: 8, topic: "Approvals", short: "Approvals", title: "Who signs", accent: "off?", desc: "Who approves, the rules we follow, and whether we can show the work." },
  ];

  var YES_NO_UNSURE = ["Yes", "No", "Not sure"];

  var QUESTIONS = [
    // ---- Goal ----
    {
      n: 1, step: 1, topic: "Goal",
      q: "What are you selling in this campaign, and what does it cost?",
      hint: "List each offer with its price, exactly as you charge it. Every price we put on screen comes from you.",
      fields: [{ key: "q01", type: "textarea", required: true, placeholder: "Each offer and its price" }],
    },
    {
      n: 2, step: 1, topic: "Goal",
      q: "What is the one action you want people to take: book, buy, sign up or call?",
      hint: "Each video and post ends on this one step.",
      fields: [
        { key: "q02", type: "radio", required: true, options: ["Book", "Buy", "Sign up", "Call", "Something else"] },
        { key: "q02_where", type: "text", label: "Where they do it", placeholder: "A link, a phone number or a place" },
      ],
    },
    {
      n: 3, step: 1, topic: "Goal",
      q: "What does success look like at 30, 60 and 90 days, and how will we count it?",
      hint: "Use numbers you can count and date, like bookings, sales or sign-ups.",
      fields: [
        { key: "q03_30", type: "text", label: "30 days", placeholder: "e.g. 20 bookings" },
        { key: "q03_60", type: "text", label: "60 days" },
        { key: "q03_90", type: "text", label: "90 days" },
        { key: "q03_count", type: "text", label: "How we'll count it", placeholder: "e.g. calendar bookings, online sales" },
      ],
    },
    {
      n: 4, step: 1, topic: "Goal",
      q: "Is there a hard date: an event, a launch, a season start?",
      hint: "A date sets the shoot, edit and posting schedule.",
      fields: [
        { key: "q04", type: "radio", required: true, options: YES_NO_UNSURE },
        { key: "q04_date", type: "date", label: "The date" },
        { key: "q04_what", type: "text", label: "What happens then", placeholder: "e.g. registration opens" },
      ],
    },

    // ---- Audience ----
    {
      n: 5, step: 2, topic: "Audience",
      q: "Who are we talking to: athletes, parents, coaches, trainers, schools, organizers or brands?",
      hint: "Pick everyone you want to reach. Each group gets its own message and call to action.",
      fields: [
        { key: "q05", type: "checks", required: true, options: ["Athletes", "Parents", "Coaches", "Trainers", "Schools", "Event organizers", "Brands", "Someone else"] },
        { key: "q05_other", type: "text", label: "Someone else", placeholder: "Who?" },
      ],
    },
    {
      n: 6, step: 2, topic: "Audience",
      q: "Are any of them under 18, and who makes the buying decision?",
      hint: "If anyone you're reaching is under 18, we film, post and message differently, and the buyer is often a parent.",
      fields: [
        { key: "q06", type: "radio", required: true, options: ["No one under 18", "Some are under 18", "Most are under 18", "Not sure"] },
        { key: "q06_buyer", type: "text", label: "Who makes the buying decision", placeholder: "e.g. parents, the head coach, the athletic director" },
      ],
    },
    {
      n: 7, step: 2, topic: "Audience",
      q: "What do they believe today, and what should they believe after?",
      hint: "The gap between the two is where the campaign starts.",
      fields: [
        { key: "q07_now", type: "textarea", label: "What they believe today" },
        { key: "q07_after", type: "textarea", label: "What they should believe after" },
      ],
    },
    {
      n: 8, step: 2, topic: "Audience",
      q: "Where do they spend time: Instagram, TikTok, YouTube, email, text, the event table?",
      hint: "This sets the formats we make (9:16, 4:5, 16:9) and whether you need QR signs.",
      fields: [{ key: "q08", type: "checks", options: ["Instagram", "TikTok", "YouTube", "Facebook", "Email", "Text messages", "At events", "Somewhere else"] }],
    },

    // ---- Brand ----
    {
      n: 9, step: 3, topic: "Brand",
      q: "What are the exact brand name, handle and domain, and are they all live?",
      hint: "Handles and domains need to exist before anything posts.",
      fields: [
        { key: "q09_name", type: "text", label: "Brand name", required: true, autocomplete: "organization" },
        { key: "q09_handles", type: "text", label: "Handles", placeholder: "@yourbrand" },
        { key: "q09_domain", type: "text", label: "Domain", placeholder: "yourbrand.com" },
        { key: "q09_live", type: "radio", label: "Are they all live?", options: ["All live", "Some", "Not yet"] },
      ],
    },
    {
      n: 10, step: 3, topic: "Brand",
      q: "Can you send the logo as SVG, plus your colours and fonts?",
      hint: "A shared folder link works. No logo yet? Say so and we'll set a type-only wordmark.",
      fields: [
        { key: "q10_link", type: "url", label: "Link to the logo and brand files", placeholder: "https://" },
        { key: "q10_notes", type: "text", label: "Colours and fonts", placeholder: "e.g. #55E62E, Archivo" },
      ],
    },
    {
      n: 11, step: 3, topic: "Brand",
      q: "Which words do you always use, and which never?",
      hint: "Your never-words join our own list of words we don't use.",
      fields: [
        { key: "q11_always", type: "text", label: "Always" },
        { key: "q11_never", type: "text", label: "Never" },
      ],
    },
    {
      n: 12, step: 3, topic: "Brand",
      q: "Any sister brands, partners or investors that must or must not appear together?",
      hint: "Some brands can't share a frame. Tell us which.",
      fields: [{ key: "q12", type: "textarea" }],
    },

    // ---- Proof ----
    {
      n: 13, step: 4, topic: "Proof",
      q: "Which results, numbers or quotes can we use, with written permission?",
      hint: "Only results you can stand behind, with written permission. Leave out the names of anyone under 18. We never make up numbers, reviews or testimonials.",
      fields: [{ key: "q13", type: "textarea" }],
    },
    {
      n: 14, step: 4, topic: "Proof",
      q: "Which partners or organizations can we name or show logos for, and is the written OK on file?",
      hint: "Names and logos appear only with the owner's written OK.",
      fields: [
        { key: "q14", type: "textarea", label: "Partners and organizations" },
        { key: "q14_ok", type: "radio", label: "Written OK on file?", options: ["For all of them", "For some", "Not yet"] },
      ],
    },
    {
      n: 15, step: 4, topic: "Proof",
      q: "Who will be on camera, and are adult releases and guardian signatures on file?",
      hint: "Roles only, no names here. Without releases, we film wide shots, backs, hands and feet.",
      fields: [
        { key: "q15_who", type: "checks", label: "Who will be on camera", options: ["No people, product only", "Adults", "Athletes under 18", "Parents", "Coaches", "Customers"] },
        { key: "q15_releases", type: "radio", required: true, label: "Releases and guardian signatures", options: ["All on file", "Some on file", "None yet", "Not sure"] },
      ],
    },
    {
      n: 16, step: 4, topic: "Proof",
      q: "Are there outside marks in the footage: venue banners, sponsor logos, watermarks?",
      hint: "We blur marks we don't have permission to show.",
      fields: [
        { key: "q16", type: "radio", options: YES_NO_UNSURE },
        { key: "q16_note", type: "text", label: "Which ones" },
      ],
    },

    // ---- Assets ----
    {
      n: 17, step: 5, topic: "Assets",
      q: "What footage and photos already exist, where are they, and who shot them?",
      hint: "Folder links are fine. Footage you already have can often be cut into new pieces.",
      fields: [
        { key: "q17", type: "textarea" },
        { key: "q17_link", type: "url", label: "Folder link", placeholder: "https://" },
      ],
    },
    {
      n: 18, step: 5, topic: "Assets",
      q: "Do we need new shoots: dates, locations, access and filming rules?",
      hint: "This becomes the shot list and the crew plan.",
      fields: [
        { key: "q18", type: "radio", options: YES_NO_UNSURE },
        { key: "q18_details", type: "textarea", label: "Dates, locations, access and filming rules" },
      ],
    },
    {
      n: 19, step: 5, topic: "Assets",
      q: "Was any footage made or altered with AI tools, and who is in it?",
      hint: "AI-made pieces are labelled and never stand in as proof or show a real minor.",
      fields: [
        { key: "q19", type: "radio", options: ["No", "Yes", "Not sure"] },
        { key: "q19_note", type: "text", label: "What was made, and whether anyone under 18 appears (no names)" },
      ],
    },
    {
      n: 20, step: 5, topic: "Assets",
      q: "Do you have licensed music, or should we score originals?",
      hint: "By default we score original music, so there's nothing to license.",
      fields: [{ key: "q20", type: "radio", options: ["Score originals", "We have licensed music", "Not sure"] }],
    },

    // ---- Funnel ----
    {
      n: 21, step: 6, topic: "Funnel",
      q: "Where does the click go: site, booking link, payment link or form? Is it working today?",
      hint: "Test it on a phone before you answer.",
      fields: [
        { key: "q21_url", type: "text", required: true, label: "Where it goes", placeholder: "https://… or 'not built yet'" },
        { key: "q21_working", type: "radio", label: "Working today?", options: YES_NO_UNSURE },
      ],
    },
    {
      n: 22, step: 6, topic: "Funnel",
      q: "Who follows up with leads, how fast, and in which tool?",
      hint: "This sets how leads are tagged and followed up.",
      fields: [
        { key: "q22_who", type: "text", label: "Who (a name or a role)" },
        { key: "q22_speed", type: "select", label: "How fast", options: ["Within an hour", "Same day", "Next day", "Not set yet"] },
        { key: "q22_tool", type: "text", label: "Which tool", placeholder: "e.g. a CRM, an inbox, a spreadsheet" },
      ],
    },
    {
      n: 23, step: 6, topic: "Funnel",
      q: "Any referral, scout or promo codes, or tracking links?",
      hint: "Codes and tracked links show which post or creator brought each customer. TOJ Campaign builds tracked links and QR codes for each channel.",
      fields: [{ key: "q23", type: "textarea" }],
    },
    {
      n: 24, step: 6, topic: "Funnel",
      q: "Is there a free first step, and what happens right after it?",
      hint: "A free first step, like a short call, gives people an easy way in.",
      fields: [{ key: "q24", type: "textarea" }],
    },

    // ---- Channels and scope ----
    {
      n: 25, step: 7, topic: "Channels",
      q: "Which formats do you need: Reels and TikTok, feed, YouTube, site hero, email?",
      hint: "Each format has its own size, length and safe zones.",
      fields: [{ key: "q25", type: "checks", options: ["Reels and TikTok (9:16)", "Feed posts (4:5)", "YouTube (16:9)", "Site hero video", "Email", "Print and QR signs", "Something else"] }],
    },
    {
      n: 26, step: 7, topic: "Channels",
      q: "Will you run paid ads? Who owns the ad account, and what is the monthly spend?",
      hint: "This sets how many versions we cut and test.",
      fields: [
        { key: "q26", type: "radio", options: YES_NO_UNSURE },
        { key: "q26_owner", type: "text", label: "Who owns the ad account" },
        { key: "q26_spend", type: "select", label: "Monthly spend", options: ["Under $500", "$500 to $2,000", "$2,000 to $5,000", "Over $5,000", "Not set yet"] },
      ],
    },
    {
      n: 27, step: 7, topic: "Scope",
      q: "How many deliverables, by when, and how many rounds of changes?",
      hint: "This sets the quote and the calendar.",
      fields: [
        { key: "q27", type: "textarea", required: true, label: "Deliverables and dates", placeholder: "e.g. three 20-second videos by March 1" },
        { key: "q27_rounds", type: "select", label: "Rounds of changes", options: ["One", "Two", "Three", "Not sure"] },
      ],
    },
    {
      n: 28, step: 7, topic: "Scope",
      q: "What is the budget for production, and separately for ads?",
      hint: "We plan production and ad spend separately.",
      fields: [
        { key: "q28_production", type: "select", required: true, label: "Production", options: ["Under $1,000", "$1,000 to $3,000", "$3,000 to $7,500", "$7,500 to $15,000", "Over $15,000", "Not sure yet"] },
        { key: "q28_ads", type: "select", label: "Ads", options: ["No ad budget", "Under $500", "$500 to $2,000", "Over $2,000", "Not sure yet"] },
      ],
    },

    // ---- Approvals ----
    {
      n: 29, step: 8, topic: "Approvals",
      q: "Who approves before anything goes live, and how fast?",
      hint: "Nothing posts or sends without sign-off.",
      fields: [
        { key: "q29_who", type: "text", required: true, label: "Who approves (a name or a role)" },
        { key: "q29_speed", type: "select", label: "How fast", options: ["Same day", "1 to 2 business days", "3 to 5 business days", "Longer"] },
      ],
    },
    {
      n: 30, step: 8, topic: "Approvals",
      q: "Any league, school, district, NIL or platform rules we must follow?",
      hint: "Schools and leagues often need their own permission.",
      fields: [
        { key: "q30", type: "radio", options: YES_NO_UNSURE },
        { key: "q30_details", type: "textarea", label: "Which rules" },
      ],
    },
    {
      n: 31, step: 8, topic: "Approvals",
      q: "Can we show this work in our portfolio and as a case study?",
      hint: "Case studies need your written OK and real numbers.",
      fields: [{ key: "q31", type: "radio", options: ["Yes", "Ask us first", "No"] }],
    },
  ];

  // The last step: who we're talking to. Contact details are stored in the
  // intake's own columns (email, phone) or as contact_* payload keys, which
  // never reach an agent (utils/embed.js skips them).
  var CONTACT = [
    { key: "contact_name", type: "text", label: "Your name", required: true, autocomplete: "name" },
    { key: "contact_role", type: "text", label: "Your role", placeholder: "e.g. owner, director, head coach", autocomplete: "organization-title" },
    { key: "contact_email", type: "email", label: "Best email", required: true, autocomplete: "email" },
    { key: "contact_phone", type: "tel", label: "Best phone", autocomplete: "tel" },
    { key: "contact_method", type: "radio", label: "Preferred first contact", required: true, options: ["Email", "Text", "Call", "Video call"] },
  ];

  // Plain text of one question's answer, from a saved payload.
  function answerText(question, payload) {
    var parts = [];
    question.fields.forEach(function (f) {
      var v = payload ? payload[f.key] : undefined;
      if (Array.isArray(v)) v = v.join(", ");
      if (v === undefined || v === null || String(v).trim() === "") return;
      var label = f.label ? f.label + (/[?]$/.test(f.label) ? " " : ": ") : "";
      parts.push(label + String(v).trim());
    });
    return parts.join(" · ");
  }

  // The answers as Markdown for TOJ, numbered like the doc. A blank stays a
  // blank: TOJ asks about it instead of guessing.
  function toMarkdown(payload, meta) {
    meta = meta || {};
    var lines = [];
    lines.push("# Campaign intake: " + (meta.brand || (payload && payload.q09_name) || "unnamed brand"));
    if (meta.received) lines.push("Received " + meta.received + " · intake " + VERSION);
    lines.push("");
    lines.push("Blank answers are open questions for Kyron, not gaps to fill.");
    STEPS.forEach(function (s) {
      lines.push("");
      lines.push("## " + s.topic);
      QUESTIONS.filter(function (q) { return q.step === s.n; }).forEach(function (q) {
        var a = answerText(q, payload);
        lines.push("");
        lines.push(q.n + ". " + q.q);
        lines.push("   Answer: " + (a ? a.replace(/\n/g, "\n   ") : "(blank)"));
      });
    });
    return lines.join("\n");
  }

  var api = { VERSION: VERSION, STEPS: STEPS, QUESTIONS: QUESTIONS, CONTACT: CONTACT, answerText: answerText, toMarkdown: toMarkdown };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TOJ_CAMPAIGN_INTAKE = api;
})(typeof window !== "undefined" ? window : this);
