(function () {
  var KEY = "pona-landing-view";
  var buttons = document.querySelectorAll(".view-toggle [data-view]");

  function apply(view) {
    var next = view === "dev" ? "dev" : "agency";
    document.body.classList.toggle("view-dev", next === "dev");
    document.body.classList.toggle("view-agency", next === "agency");
    document.title = next === "dev" ? "pona flow — for developers" : "pona flow — for agencies";
    buttons.forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-view") === next ? "true" : "false");
    });
    try {
      localStorage.setItem(KEY, next);
    } catch (_) {}
    var url = new URL(window.location.href);
    url.searchParams.set("view", next);
    history.replaceState(null, "", url);
  }

  var fromQuery = new URLSearchParams(window.location.search).get("view");
  var fromStore = null;
  try {
    fromStore = localStorage.getItem(KEY);
  } catch (_) {}
  apply(fromQuery || fromStore || "agency");

  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      apply(btn.getAttribute("data-view"));
    });
  });
})();
