/* Apply persisted theme before CSS paints to avoid flash */
(function () {
  try {
    var theme = localStorage.getItem('mw-theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
