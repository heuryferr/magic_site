/* ===== Magic Stat — main.js ===== */
(function () {
  'use strict';

  // ---- Navbar mobile ----
  var burger = document.getElementById('navBurger');
  var navLinks = document.getElementById('navLinks');
  if (burger && navLinks) {
    burger.addEventListener('click', function () {
      var open = navLinks.classList.toggle('open');
      burger.classList.toggle('open', open);
    });
    navLinks.addEventListener('click', function () {
      navLinks.classList.remove('open');
      burger.classList.remove('open');
    });
  }

  // ---- Carrossel ----
  var track = document.getElementById('carousel');
  var dotsBox = document.getElementById('carouselDots');
  var prevBtn = document.getElementById('carouselPrev');
  var nextBtn = document.getElementById('carouselNext');
  if (track) {
    var slides = track.querySelectorAll('.slide');
    var index = 0;
    var count = slides.length;

    slides.forEach(function (_, i) {
      var d = document.createElement('button');
      d.setAttribute('aria-label', 'Ir para slide ' + (i + 1));
      d.addEventListener('click', function () { goTo(i); });
      dotsBox.appendChild(d);
    });
    var dots = dotsBox.querySelectorAll('button');

    function goTo(i) {
      index = (i + count) % count;
      track.scrollTo({ left: track.clientWidth * index, behavior: 'smooth' });
      dots.forEach(function (d, k) { d.classList.toggle('active', k === index); });
    }
    function next() { goTo(index + 1); }
    function prev() { goTo(index - 1); }
    if (prevBtn) prevBtn.addEventListener('click', prev);
    if (nextBtn) nextBtn.addEventListener('click', next);
    goTo(0);

    // swipe
    var startX = 0;
    track.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; });
    track.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 40) { dx < 0 ? next() : prev(); }
    });

    // autoplay
    var timer = setInterval(next, 5000);
    track.addEventListener('mouseenter', function () { clearInterval(timer); });
    track.addEventListener('mouseleave', function () { timer = setInterval(next, 5000); });
  }

  // ---- Contadores animados ----
  var statNums = document.querySelectorAll('.stat-num[data-target]');
  if (statNums.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animate(entry.target);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    statNums.forEach(function (el) { io.observe(el); });
  }

  function animate(el) {
    var target = parseInt(el.getAttribute('data-target'), 10);
    var duration = 1200;
    var start = performance.now();
    function tick(now) {
      var p = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out
      el.textContent = Math.round(target * eased);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target + '+';
    }
    requestAnimationFrame(tick);
  }

  // ---- FAQ accordion ----
  var faqs = document.querySelectorAll('.faq-item');
  faqs.forEach(function (item) {
    var q = item.querySelector('.faq-q');
    var a = item.querySelector('.faq-a');
    if (!q || !a) return;
    q.addEventListener('click', function () {
      var isOpen = item.classList.contains('open');
      faqs.forEach(function (other) { other.classList.remove('open'); other.querySelector('.faq-a').style.maxHeight = null; });
      if (!isOpen) {
        item.classList.add('open');
        a.style.maxHeight = a.scrollHeight + 'px';
      }
    });
  });

  // ---- Ano do rodapé ----
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
