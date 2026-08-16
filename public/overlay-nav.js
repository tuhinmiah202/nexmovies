/**
 * Overlay Navigation Arrows (moviebox.ph style)
 * Adds left/right overlay arrows to each movie row for scrolling content.
 * Uses MutationObserver to detect dynamically loaded content.
 */

(function () {
  'use strict';

  var LEFT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
  var RIGHT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>';

  function addOverlayArrows(row) {
    if (row.querySelector('.row-overlay-nav')) return;

    var scroll = row.querySelector('.row-scroll');
    if (!scroll) return;

    var leftNav = document.createElement('div');
    leftNav.className = 'row-overlay-nav left-side';
    var leftBtn = document.createElement('button');
    leftBtn.className = 'row-overlay-arrow overlay-arrow-left';
    leftBtn.setAttribute('aria-label', 'Scroll left');
    leftBtn.innerHTML = LEFT_SVG;
    leftNav.appendChild(leftBtn);

    var rightNav = document.createElement('div');
    rightNav.className = 'row-overlay-nav right-side';
    var rightBtn = document.createElement('button');
    rightBtn.className = 'row-overlay-arrow overlay-arrow-right';
    rightBtn.setAttribute('aria-label', 'Scroll right');
    rightBtn.innerHTML = RIGHT_SVG;
    rightNav.appendChild(rightBtn);

    row.appendChild(leftNav);
    row.appendChild(rightNav);

    function updateArrows() {
      var maxScroll = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      var atStart = scroll.scrollLeft <= 1;
      var atEnd = scroll.scrollLeft >= maxScroll - 1;
      leftBtn.classList.toggle('disabled', atStart);
      rightBtn.classList.toggle('disabled', atEnd);
    }

    leftBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      scroll.scrollBy({ left: -Math.round(scroll.clientWidth * 0.85), behavior: 'smooth' });
    });

    rightBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      scroll.scrollBy({ left: Math.round(scroll.clientWidth * 0.85), behavior: 'smooth' });
    });

    var rafId = null;
    function onScroll() {
      if (rafId) return;
      rafId = requestAnimationFrame(function () {
        updateArrows();
        rafId = null;
      });
    }
    scroll.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    updateArrows();
  }

  function processAllRows() {
    document.querySelectorAll('.movie-row').forEach(addOverlayArrows);
  }

  var observer = new MutationObserver(function (mutations) {
    var shouldProcess = false;
    for (var i = 0; i < mutations.length; i++) {
      var mutation = mutations[i];
      if (mutation.addedNodes.length > 0) {
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var node = mutation.addedNodes[j];
          if (node.nodeType === 1) {
            if (node.classList && node.classList.contains('movie-row')) {
              shouldProcess = true;
              break;
            }
            if (node.querySelector && node.querySelector('.movie-row')) {
              shouldProcess = true;
              break;
            }
          }
        }
      }
      if (shouldProcess) break;
    }
    if (shouldProcess) {
      setTimeout(processAllRows, 50);
    }
  });

  var contentArea = document.getElementById('contentArea');
  if (contentArea) {
    observer.observe(contentArea, { childList: true, subtree: true });
  }

  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(processAllRows, 100);
  setInterval(processAllRows, 2000);
})();