;(function () {
  var key = "queryai-theme-id"
  var themeId = localStorage.getItem(key) || "editorial"

  if (themeId === "oc-1") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("queryai-theme-css-light")
    localStorage.removeItem("queryai-theme-css-dark")
  }

  // Editorial Warm paint-before-hydrate colours, so the first frame is never cold white/black.
  var EDITORIAL_BG = { light: "#fbf7f0", dark: "#100d0b" }

  var scheme = localStorage.getItem("queryai-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = EDITORIAL_BG[mode]

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", EDITORIAL_BG[mode])

  if (themeId === "oc-2") return

  var css = localStorage.getItem("queryai-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
