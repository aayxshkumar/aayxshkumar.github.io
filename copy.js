// Copy buttons for commands. They stay hidden without JS or a clipboard;
// the command is always there to select by hand.
(() => {
  "use strict";
  if (!navigator.clipboard) return;
  const say = document.createElement("p");
  say.className = "vh";
  say.setAttribute("role", "status");
  document.body.append(say);
  for (const b of document.querySelectorAll("button.copy[data-copy]")) {
    b.hidden = false;
    if (!b.hasAttribute("aria-label")) b.setAttribute("aria-label", "Copy the command");
    let t;
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
      } catch {
        say.textContent = "Couldn’t copy; select the command instead.";
        return;
      }
      b.dataset.copied = "";
      // empty the region first, so a second copy of the same command is announced too
      say.textContent = "";
      setTimeout(() => { say.textContent = "Copied."; }, 60);
      clearTimeout(t);
      t = setTimeout(() => { delete b.dataset.copied; }, 1600);
    });
  }
})();
