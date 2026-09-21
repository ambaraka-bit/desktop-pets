/**
 * ChatBubble.js
 * ============================================================
 * A self-contained, dependency-free pixel-art chat bubble that
 * auto-expands to fit whatever text you give it, using a 9-slice
 * border-image so the border and tail never get stretched/warped.
 *
 * Usage:
 *   const bubble = new ChatBubble({
 *     imagePath: "Chat_Bubble.png",
 *     parent: document.body,   // or your pet's container element
 *   });
 *
 *   bubble.say("Hello!");                 // shows the bubble
 *   bubble.say("Longer message that will wrap and grow taller.");
 *   bubble.setPosition(petX, petY);       // anchor it near your pet
 *   bubble.hide();
 *
 * How the auto-expand works:
 *   The bubble is a normal DOM element styled with a CSS
 *   border-image 9-slice (details in _injectStyles()). Because of
 *   that, simply changing its textContent is enough — the browser
 *   reflows the box to fit the new text, and the border-image
 *   redraws itself around the new size automatically. There is no
 *   manual resize math anywhere in this file.
 * ============================================================
 */

class ChatBubble {
  /**
   * @param {Object} options
   * @param {string} options.imagePath   Path/URL to the bubble PNG.
   * @param {HTMLElement} [options.parent=document.body] Where to mount it.
   * @param {number} [options.scale=0.04] On-screen scale of the border
   *        art. Scales all 4 border-image slices uniformly, so the tail
   *        never distorts. Tune to taste (try 0.03–0.06).
   * @param {number} [options.maxWidth=300] Max bubble width in px
   *        before text starts wrapping to a new line.
   * @param {number} [options.fontScale=1] Multiplier for the 15px base text
   *        size (and padding), so the bubble stays proportioned on HiDPI /
   *        larger-pet setups.
   * @param {Object} [options.slice] Border-image slice values in SOURCE
   *        image pixels (top/right/bottom/left), i.e. where the flat
   *        border ends and the fillable interior begins. Defaults were
   *        measured pixel-by-pixel from the 5000x5000 Chat_Bubble.png:
   *        a ~159px outline ringing a white body, with the speech tail in
   *        the bottom-left reaching down to y=4215. The slice values keep
   *        every corner arc and the tail inside the (unstretched) corner
   *        regions. If you swap in a differently-sized or differently-
   *        shaped bubble asset, re-measure these.
   * @param {number} [options.tailTipFromBottom=785] Source-image pixels from
   *        the tail's tip up to the image's bottom edge (everything below the
   *        tip is transparent). Used so the tail can be planted exactly on an
   *        anchor point.
   * @param {number} [options.hideDelay=0] If > 0, auto-hides the bubble
   *        this many ms after each say() call. 0 = stays until hide().
   */
  constructor(options = {}) {
    this.imagePath = options.imagePath;
    if (!this.imagePath) {
      throw new Error("ChatBubble: options.imagePath is required");
    }

    this.parent = options.parent || document.body;
    this.scale = options.scale ?? 0.04;
    this.maxWidth = options.maxWidth ?? 300;
    this.fontScale = options.fontScale ?? 1;
    this.slice = Object.assign(
      { top: 1350, right: 700, bottom: 1720, left: 1750 }, // measured defaults
      options.slice || {}
    );
    this.tailTipFromBottom = options.tailTipFromBottom ?? 785;
    this.hideDelay = options.hideDelay ?? 0;

    this._hideTimer = null;

    this._injectStyles();
    this._buildElement();
  }

  /** Injects the one shared <style> block (only once per page/app). */
  _injectStyles() {
    if (document.getElementById("chat-bubble-styles")) return;

    const style = document.createElement("style");
    style.id = "chat-bubble-styles";
    style.textContent = `
      .pet-chat-bubble {
        position: absolute;
        box-sizing: border-box;
        display: inline-block;

        border-style: solid;
        border-image-repeat: stretch;
        image-rendering: pixelated;
        image-rendering: -moz-crisp-edges;
        image-rendering: crisp-edges;

        font-family: -apple-system, "Segoe UI", sans-serif;
        font-size: 15px;
        line-height: 1.35;
        color: #111;
        word-wrap: break-word;
        overflow-wrap: break-word;
        white-space: pre-wrap;

        opacity: 0;
        transform: scale(0.85);
        transform-origin: bottom left;
        transition: opacity 120ms ease-out, transform 120ms ease-out;
        pointer-events: none;
      }

      .pet-chat-bubble.visible {
        opacity: 1;
        transform: scale(1);
      }
    `;
    document.head.appendChild(style);
  }

  /** Creates the bubble DOM element and applies its 9-slice sizing. */
  _buildElement() {
    const el = document.createElement("div");
    el.className = "pet-chat-bubble";

    const { top, right, bottom, left } = this.slice;
    const s = this.scale;

    el.style.borderImageSource = `url("${this.imagePath}")`;
    el.style.borderImageSlice = `${top} ${right} ${bottom} ${left} fill`;
    el.style.borderWidth = `${top * s}px ${right * s}px ${bottom * s}px ${left * s}px`;
    el.style.borderImageWidth = `${top * s}px ${right * s}px ${bottom * s}px ${left * s}px`;
    // Floor the width just above the two side borders so even a tiny message
    // keeps a sane, readable text area instead of collapsing to zero width.
    el.style.minWidth = `${(left + right) * s + 64}px`;
    el.style.maxWidth = `${this.maxWidth}px`;
    // Size the text + inner padding with the bubble so it stays proportioned
    // when the pet/screen scaling changes.
    el.style.fontSize = `${15 * this.fontScale}px`;
    el.style.padding = `${6 * this.fontScale}px ${10 * this.fontScale}px`;

    this.parent.appendChild(el);
    this.el = el;
  }

  /**
   * Shows the bubble with the given text. Safe to call repeatedly —
   * each call just updates the text and lets the border-image reflow.
   */
  say(text) {
    this.el.textContent = text;
    this.el.classList.add("visible");

    clearTimeout(this._hideTimer);
    if (this.hideDelay > 0) {
      this._hideTimer = setTimeout(() => this.hide(), this.hideDelay);
    }
  }

  /** Hides the bubble (keeps it in the DOM for reuse). */
  hide() {
    this.el.classList.remove("visible");
    clearTimeout(this._hideTimer);
  }

  /**
   * Positions the element's TOP-LEFT corner at (x, y) in the parent's
   * coordinate space. For speech bubbles anchored by their tail tip, callers
   * should account for `tailTipFromBottom * scale` (the tail tip sits above
   * the element's bottom edge) — see renderer-draw.js's updateChatBubble().
   */
  setPosition(x, y) {
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  /** Live-adjust the on-screen scale of the border art (e.g. if your pet resizes). */
  setScale(scale) {
    this.scale = scale;
    const { top, right, bottom, left } = this.slice;
    const s = scale;
    this.el.style.borderWidth = `${top * s}px ${right * s}px ${bottom * s}px ${left * s}px`;
    this.el.style.borderImageWidth = `${top * s}px ${right * s}px ${bottom * s}px ${left * s}px`;
    this.el.style.minWidth = `${(left + right) * s + 64}px`;
  }

  /** Removes the bubble element entirely. */
  destroy() {
    clearTimeout(this._hideTimer);
    this.el.remove();
  }
}

// Support both ES module and plain <script> usage.
if (typeof module !== "undefined" && module.exports) {
  module.exports = ChatBubble;
}