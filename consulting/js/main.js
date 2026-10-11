/* ============================================
   MAIN JAVASCRIPT - Dr. Heury Ferr
   Statistical Analysis Consulting
   ============================================ */

'use strict';

// ============================================
// DOM Ready
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initNavbar();
    initMobileMenu();
    initScrollAnimations();
    initCounterAnimation();
    initTestimonialSlider();
    initFAQ();
    initSmoothScroll();
    initScrollSpy();
    initBudgetForm();
    initEmailTracking();
});

// ============================================
// NAVBAR - Scroll effect
// ============================================
function initNavbar() {
    const navbar = document.getElementById('navbar');
    let lastScroll = 0;

    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;

        // Add/remove background on scroll
        if (currentScroll > 50) {
            navbar.classList.add('navbar--scrolled');
        } else {
            navbar.classList.remove('navbar--scrolled');
        }

        lastScroll = currentScroll;
    }, { passive: true });
}

// ============================================
// MOBILE MENU
// ============================================
function initMobileMenu() {
    const toggle = document.getElementById('navToggle');
    const links = document.getElementById('navLinks');
    const navLinks = document.querySelectorAll('.navbar__link');

    if (!toggle || !links) return;

    toggle.addEventListener('click', () => {
        const isOpen = links.classList.toggle('active');
        toggle.classList.toggle('active');
        toggle.setAttribute('aria-expanded', isOpen);
        document.body.style.overflow = isOpen ? 'hidden' : '';
    });

    // Close menu on link click
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            links.classList.remove('active');
            toggle.classList.remove('active');
            toggle.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
        });
    });

    // Close menu on outside click
    document.addEventListener('click', (e) => {
        if (!links.contains(e.target) && !toggle.contains(e.target)) {
            links.classList.remove('active');
            toggle.classList.remove('active');
            toggle.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
        }
    });

    // Close menu on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && links.classList.contains('active')) {
            links.classList.remove('active');
            toggle.classList.remove('active');
            toggle.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
        }
    });
}

// ============================================
// SCROLL ANIMATIONS - Intersection Observer
// ============================================
function initScrollAnimations() {
    const animateElements = document.querySelectorAll(
        '.service-card, .benefit-card, .step, .testimonial-card, ' +
        '.about__content, .about__visual, .faq__item, .hero__content, ' +
        '.publication-card, .publications__badge'
    );

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
            if (entry.isIntersecting) {
                // Stagger animation
                const delay = index * 0.1;
                entry.target.style.animationDelay = `${delay}s`;
                entry.target.classList.add('animate-in');
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    animateElements.forEach(el => {
        el.style.opacity = '0';
        observer.observe(el);
    });
}

// ============================================
// COUNTER ANIMATION - Stats numbers
// ============================================
function initCounterAnimation() {
    const counters = document.querySelectorAll('.hero__stat-number');
    if (!counters.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const target = entry.target;
                const max = parseFloat(target.getAttribute('data-count'));
                animateCounter(target, max);
                observer.unobserve(target);
            }
        });
    }, { threshold: 0.5 });

    counters.forEach(counter => observer.observe(counter));
}

function animateCounter(element, target) {
    const duration = 2000; // 2 seconds
    const steps = 60;
    const increment = target / steps;
    let current = 0;
    let step = 0;
    const isInteger = Number.isInteger(target);
    const suffix = element.getAttribute('data-suffix') || '+';

    const timer = setInterval(() => {
        step++;
        current = isInteger
            ? Math.min(Math.round(increment * step), target)
            : Math.min(Math.round((increment * step) * 10) / 10, target);
        element.textContent = current + suffix;

        if (step >= steps) {
            clearInterval(timer);
            element.textContent = target + suffix;
        }
    }, duration / steps);
}

// ============================================
// TESTIMONIAL SLIDER
// ============================================
function initTestimonialSlider() {
    const slider = document.getElementById('testimonialSlider');
    const dotsContainer = document.getElementById('testimonialDots');
    const prevBtn = document.querySelector('.testimonials__btn--prev');
    const nextBtn = document.querySelector('.testimonials__btn--next');

    if (!slider || !dotsContainer) return;

    const cards = slider.querySelectorAll('.testimonial-card');
    const totalSlides = cards.length;
    let currentSlide = 0;
    let autoPlayInterval;
    let isTransitioning = false;

    // Auto-play
    startAutoPlay();

    // Event listeners
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (isTransitioning) return;
            goToSlide(currentSlide - 1);
            resetAutoPlay();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (isTransitioning) return;
            goToSlide(currentSlide + 1);
            resetAutoPlay();
        });
    }

    // Dot click
    dotsContainer.addEventListener('click', (e) => {
        const dot = e.target.closest('span');
        if (!dot || isTransitioning) return;
        const index = Array.from(dotsContainer.children).indexOf(dot);
        if (index === currentSlide) return;
        goToSlide(index);
        resetAutoPlay();
    });

    // Touch events for mobile
    let touchStartX = 0;
    let touchEndX = 0;

    slider.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    slider.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });

    function handleSwipe() {
        if (isTransitioning) return;
        const swipeThreshold = 50;
        const diff = touchStartX - touchEndX;

        if (Math.abs(diff) > swipeThreshold) {
            if (diff > 0) {
                goToSlide(currentSlide + 1);
            } else {
                goToSlide(currentSlide - 1);
            }
            resetAutoPlay();
        }
    }

    function goToSlide(index) {
        if (index < 0) index = totalSlides - 1;
        if (index >= totalSlides) index = 0;
        if (index === currentSlide || isTransitioning) return;
        
        isTransitioning = true;
        currentSlide = index;
        
        // Slide using translateX
        slider.style.transform = `translateX(-${currentSlide * 100}%)`;
        
        updateDots();
        
        setTimeout(() => {
            isTransitioning = false;
        }, 500);
    }

    function updateDots() {
        const dotElements = dotsContainer.querySelectorAll('span');
        dotElements.forEach((dot, i) => {
            dot.classList.toggle('active', i === currentSlide);
        });
    }

    function startAutoPlay() {
        if (autoPlayInterval) clearInterval(autoPlayInterval);
        autoPlayInterval = setInterval(() => {
            if (!isTransitioning) {
                goToSlide(currentSlide + 1);
            }
        }, 6000);
    }

    function resetAutoPlay() {
        clearInterval(autoPlayInterval);
        startAutoPlay();
    }

    // Pause on hover over the slider area
    const sliderArea = slider.closest('.testimonials');
    if (sliderArea) {
        sliderArea.addEventListener('mouseenter', () => {
            clearInterval(autoPlayInterval);
        });
        sliderArea.addEventListener('mouseleave', startAutoPlay);
    }
}

// ============================================
// FAQ ACCORDION
// ============================================
function initFAQ() {
    const faqItems = document.querySelectorAll('.faq__item');

    faqItems.forEach(item => {
        const question = item.querySelector('.faq__question');
        const answer = item.querySelector('.faq__answer');

        question.addEventListener('click', () => {
            const isOpen = item.classList.contains('active');

            // Close all
            faqItems.forEach(other => {
                other.classList.remove('active');
                other.querySelector('.faq__question').setAttribute('aria-expanded', 'false');
            });

            // Open current if it was closed
            if (!isOpen) {
                item.classList.add('active');
                question.setAttribute('aria-expanded', 'true');
            }
        });

        // Keyboard support
        question.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                question.click();
            }
        });
    });
}

// ============================================
// SMOOTH SCROLL
// ============================================
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', (e) => {
            const targetId = anchor.getAttribute('href');
            if (targetId === '#') return;

            const target = document.querySelector(targetId);
            if (!target) return;

            e.preventDefault();

            const navbarHeight = document.querySelector('.navbar').offsetHeight;
            const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navbarHeight;

            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });
        });
    });
}

// ============================================
// SCROLL SPY - Active nav link
// ============================================
function initScrollSpy() {
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.navbar__link:not(.navbar__link--cta)');

    if (!sections.length || !navLinks.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const currentId = entry.target.id;

                navLinks.forEach(link => {
                    link.style.color = '';
                    if (link.getAttribute('href') === `#${currentId}`) {
                        link.style.color = 'var(--color-accent)';
                    }
                });
            }
        });
    }, {
        threshold: 0.3,
        rootMargin: '-80px 0px 0px 0px'
    });

    sections.forEach(section => observer.observe(section));
}

// ============================================
// PERFORMANCE: Lazy load images
// ============================================
if ('loading' in HTMLImageElement.prototype) {
    const images = document.querySelectorAll('img[loading="lazy"]');
    images.forEach(img => {
        img.src = img.dataset.src;
    });
} else {
    // Fallback for older browsers
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lazysizes/5.3.2/lazysizes.min.js';
    document.body.appendChild(script);
}

// ============================================
// EMAIL CLICK TRACKING - conversion event
// ============================================
function initEmailTracking() {
    const emailLinks = document.querySelectorAll('a[href^="mailto:"]');
    emailLinks.forEach(link => {
        link.addEventListener('click', () => {
            if (typeof gtag !== 'undefined') {
                // Conversion event on email contact
                gtag('event', 'conversion_event_contact', {
                    'event_category': 'contact',
                    'event_label': 'email_click'
                });
            }
        });
    });
}

// ============================================
// QUOTE FORM - Validation & Submission
// ============================================
function initBudgetForm() {
    const form = document.getElementById('budgetForm');
    if (!form) return;

    const submitBtn = document.getElementById('formSubmit');
    const submitText = submitBtn.querySelector('.form__submit-text');
    const submitLoading = submitBtn.querySelector('.form__submit-loading');
    const successMsg = document.getElementById('formSuccess');

    // Real-time validation on blur
    const inputs = form.querySelectorAll('.form__input, .form__textarea');
    inputs.forEach(input => {
        input.addEventListener('blur', () => validateField(input));
        input.addEventListener('input', () => {
            if (input.classList.contains('error')) {
                validateField(input);
            }
        });
    });

    // Form submission
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Validate all fields
        let isValid = true;
        const requiredFields = form.querySelectorAll('[required]');
        requiredFields.forEach(field => {
            if (!validateField(field)) {
                isValid = false;
            }
        });

        if (!isValid) {
            // Scroll to first error
            const firstError = form.querySelector('.error');
            if (firstError) {
                firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            return;
        }

        // Show loading state
        submitBtn.disabled = true;
        submitText.style.display = 'none';
        submitLoading.style.display = 'inline-flex';

        // Collect form data
        const formData = collectFormData(form);

        try {
            // Send via Formspree
            await sendFormData(formData);
            
            // Show success
            form.querySelector('.form__grid').style.display = 'none';
            form.querySelector('.form__actions').style.display = 'none';
            successMsg.style.display = 'block';
            
            // Scroll to success message
            successMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Form-submit conversions (Google Ads + GA4)
            if (typeof gtag !== 'undefined') {
                var formDataEvent = {
                    'event_category': 'form',
                    'event_label': formData.workType,
                    'work_type': formData.workType,
                    'services': formData.services.join(', ')
                };
                // Conversion name "Request a quote" (REQUEST_QUOTE) in Google Ads
                gtag('event', 'conversion_event_submit_lead_form', formDataEvent);
                // Kept for compatibility (in case the conversion was created as "purchase")
                gtag('event', 'conversion_event_purchase', formDataEvent);
            }

        } catch (error) {
            console.error('Error submitting form:', error);
            alert('Oops! Something went wrong while sending your request. Please email me directly at heuryferr@gmail.com.');
        } finally {
            submitBtn.disabled = false;
            submitText.style.display = 'inline';
            submitLoading.style.display = 'none';
        }
    });
}

function validateField(field) {
    const group = field.closest('.form__group');
    if (!group) return true;

    let valid = true;

    if (field.hasAttribute('required')) {
        if (field.type === 'email') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            valid = emailRegex.test(field.value.trim());
        } else if (field.tagName === 'TEXTAREA') {
            valid = field.value.trim().length >= 10;
        } else {
            valid = field.value.trim().length > 0;
        }
    }

    group.classList.toggle('error', !valid);
    field.classList.toggle('error', !valid);
    return valid;
}

function collectFormData(form) {
    const formData = new FormData(form);
    // Origem do trafego (Google Ads / campanhas) SEM depender de tags do Google
    const params = new URLSearchParams(window.location.search);
    
    // Get selected services (checkboxes)
    const services = [];
    form.querySelectorAll('input[name="services"]:checked').forEach(cb => {
        services.push(cb.value);
    });

    // Get work type
    const workType = form.querySelector('input[name="workType"]:checked')?.value || 'Not provided';
    
    // Get deadline
    const deadline = form.querySelector('input[name="deadline"]:checked')?.value || 'Not provided';

    return {
        name: formData.get('name') || '',
        email: formData.get('email') || '',
        workType: workType,
        services: services,
        deadline: deadline,
        university: formData.get('university') || '',
        database: formData.get('database') || '',
        objectives: formData.get('objectives') || '',
        referral: formData.get('referral') || '',
        gclid: params.get('gclid') || '',
        gbraid: params.get('gbraid') || '',
        wbraid: params.get('wbraid') || '',
        utm_source: params.get('utm_source') || '',
        utm_medium: params.get('utm_medium') || '',
        utm_campaign: params.get('utm_campaign') || '',
        landing_page: window.location.href,
        referrer: document.referrer || '',
        submittedAt: new Date().toLocaleString('en-US', {
            timeZone: 'America/New_York'
        })
    };
}

async function sendFormData(data) {
    const servicesList = data.services.length > 0
        ? data.services.map(s => `• ${s}`).join('\n')
        : 'No specific service selected';

    // Formspree submission (AJAX / JSON)
    const response = await fetch('https://formspree.io/f/xbgdkkkb', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            name: data.name,
            email: data.email,
            workType: data.workType,
            services: servicesList,
            deadline: data.deadline,
            university: data.university,
            database: data.database,
            objectives: data.objectives,
            referral: data.referral,
            gclid: data.gclid,
            gbraid: data.gbraid,
            wbraid: data.wbraid,
            utm_source: data.utm_source,
            utm_medium: data.utm_medium,
            utm_campaign: data.utm_campaign,
            landing_page: data.landing_page,
            referrer: data.referrer,
            submittedAt: data.submittedAt,
            _subject: `New Quote Request - ${data.name} - ${data.workType}`,
            _replyto: data.email
        })
    });

    if (!response.ok) {
        throw new Error('Failed to submit form');
    }
}

console.log('🏛️ Dr. Heury Ferr - Statistical Analysis Consulting');
console.log('📊 Turning data into scientific discoveries');
