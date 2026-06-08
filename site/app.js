const tickerTrack = document.querySelector('.ticker-track');
if (tickerTrack) {
  tickerTrack.innerHTML = `${tickerTrack.innerHTML}${tickerTrack.innerHTML}`;
}

const counters = [...document.querySelectorAll('[data-count]')];
const counterObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    animateCounter(entry.target);
    counterObserver.unobserve(entry.target);
  }
}, { threshold: 0.55 });

for (const counter of counters) counterObserver.observe(counter);

function animateCounter(node) {
  const target = Number(node.dataset.count ?? 0);
  const suffix = target === 100 ? '%' : '';
  const start = performance.now();
  const duration = 1100;

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = `${Math.round(target * eased)}${suffix}`;
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

const header = document.querySelector('.site-header');
let lastScrolled = false;

window.addEventListener('scroll', () => {
  const scrolled = window.scrollY > 24;
  if (scrolled === lastScrolled) return;
  lastScrolled = scrolled;
  header?.classList.toggle('is-scrolled', scrolled);
}, { passive: true });
