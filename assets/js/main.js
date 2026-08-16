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

  // ---- AI demo carousel (palco unico; execução 100% automatica) ----
  var track = document.getElementById('aiDemo');
  var dotsBox = document.getElementById('carouselDots');
  var prevBtn = document.getElementById('carouselPrev');
  var nextBtn = document.getElementById('carouselNext');
  if (track) {
    var slides = track.querySelectorAll('.scene');
    var index = 0;
    var count = slides.length;
    var typingTimers = [];
    var MS_PER_CHAR = 20;      // velocidade da digitação
    var PAUSE_AFTER_MSG = 420; // pausa entre as bolhas (ms)
    var FIGURE_HOLD = 3200;    // tempo exibindo a figura antes de avançar (ms)
    var autoTimer = null;

    // Cria os dots (não-autofires; apenas indicadores)
    slides.forEach(function (_, i) {
      var d = document.createElement('button');
      d.setAttribute('aria-label', 'Scene ' + (i + 1));
      d.addEventListener('click', function () { goTo(i); });
      dotsBox.appendChild(d);
    });
    var dots = dotsBox.querySelectorAll('button');

    function clearTyping() {
      typingTimers.forEach(function (t) { window.clearTimeout(t); window.clearInterval(t); });
      typingTimers = [];
    }

    // Duração total de uma cena = digitação + figura
    function sceneDur(s) {
      var total = 250;
      s.querySelectorAll('.typing.msg').forEach(function (m) {
        total += (m.getAttribute('data-text') || '').length * MS_PER_CHAR + PAUSE_AFTER_MSG;
      });
      return total + FIGURE_HOLD;
    }

    // Digita letra a letra a cena atual; ao terminar, mostra a figura.
    function playScene(scene) {
      var msgs = scene.querySelectorAll('.typing.msg');
      msgs.forEach(function (m) { m.textContent = ''; });
      scene.classList.remove('show-fig');

      var seq = 0;              // mensagem atual
      function typeNext() {
        if (!scene.classList.contains('active')) return;
        if (seq >= msgs.length) {
          // fim do diálogo: mostra a figura
          scene.classList.add('show-fig');
          return;
        }
        var m = msgs[seq];
        var text = m.getAttribute('data-text') || '';
        var pos = 0;
        var t = window.setInterval(function () {
          if (!scene.classList.contains('active')) { window.clearInterval(t); return; }
          pos++;
          m.textContent = text.slice(0, pos);
          if (pos >= text.length) {
            window.clearInterval(t);
            seq++;
            typingTimers.push(window.setTimeout(typeNext, PAUSE_AFTER_MSG));
          }
        }, MS_PER_CHAR);
        typingTimers.push(t);
      }
      typeNext();
    }

    function goTo(i) {
      window.clearInterval(autoTimer);
      index = (i + count) % count;
      slides.forEach(function (s, k) {
        var on = k === index;
        s.classList.toggle('active', on);
        s.classList.toggle('show-fig', false);
      });
      dots.forEach(function (d, k) { d.classList.toggle('active', k === index); });
      clearTyping();
      playScene(slides[index]);
      // Autoplay: avança sozinho depois da duração da cena
      autoTimer = window.setInterval(next, sceneDur(slides[index]));
    }
    function next() { goTo(index + 1); }
    function prev() { goTo(index - 1); }
    var autoTimer = null;
    if (prevBtn) prevBtn.addEventListener('click', next);
    if (nextBtn) nextBtn.addEventListener('click', prev);

    goTo(0); // inicia o carrossel

    // swipe (opcional, automático também avança)
    var startX = 0;
    track.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; });
    track.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 40) { dx < 0 ? next() : prev(); }
    });
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

  // ---- Lightbox (fullscreen, original quality) ----
  var lightbox = document.getElementById('lightbox');
  var lbImg = document.getElementById('lbImg');
  var lbCount = document.getElementById('lbCount');
  var lbDpi = document.getElementById('lbDpi');
  var lbPrev = document.getElementById('lbPrev');
  var lbNext = document.getElementById('lbNext');
  var lbClose = document.getElementById('lbClose');

  if (lightbox && lbImg) {
    // Coleção de imagens clicáveis (galeria + cenas do demo + carrossel)
    var lbSources = Array.prototype.slice.call(
      document.querySelectorAll('.g-media img[data-full], .scene-figure img[data-full], .slide img[data-full]')
    );

    var lbIndex = 0;

    function openLb(idx) {
      lbIndex = (idx + lbSources.length) % lbSources.length;
      var img = lbSources[lbIndex];
      var full = img.getAttribute('data-full') || img.src;
      lbImg.src = full;
      lbImg.alt = img.alt || '';
      lbImg.classList.remove('zoomed');
      updateMeta(img, full);
      lightbox.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeLb() {
      lightbox.classList.remove('open');
      document.body.style.overflow = '';
    }
    function nextLb() { openLb(lbIndex + 1); }
    function prevLb() { openLb(lbIndex - 1); }

    function updateMeta(img, src) {
      if (lbCount) lbCount.textContent = (lbIndex + 1) + ' / ' + lbSources.length;
      if (lbDpi) {
        var i = new Image();
        i.onload = function () { lbDpi.textContent = i.naturalWidth + ' × ' + i.naturalHeight + ' px'; };
        i.onerror = function () { lbDpi.textContent = ''; };
        i.src = src;
      }
    }

    // Abrir ao clicar
    lbSources.forEach(function (img, i) {
      var host = img.closest('.g-media, .scene-figure, .slide') || img;
      host.addEventListener('click', function () { openLb(i); });
    });

    // Navegação
    if (lbPrev) lbPrev.addEventListener('click', function (e) { e.stopPropagation(); prevLb(); });
    if (lbNext) lbNext.addEventListener('click', function (e) { e.stopPropagation(); nextLb(); });
    if (lbClose) lbClose.addEventListener('click', closeLb);

    // Zoom (qualidade original, 1:1) ao clicar na imagem
    lbImg.addEventListener('click', function (e) { e.stopPropagation(); lbImg.classList.toggle('zoomed'); });

    // Fechar clicando no fundo
    lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLb(); });

    // Teclado: Esc fecha, setas navegam
    document.addEventListener('keydown', function (e) {
      if (!lightbox.classList.contains('open')) return;
      if (e.key === 'Escape') closeLb();
      else if (e.key === 'ArrowRight') nextLb();
      else if (e.key === 'ArrowLeft') prevLb();
    });
  }
})();
