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

const cookieBanner = document.querySelector('.cookie-banner');
const acceptCookies = document.querySelector('.cookie-accept');
const rejectCookies = document.querySelector('.cookie-reject');
const cookieChoiceKey = 'pandora_cookie_choice';

try {
  const existingChoice = localStorage.getItem(cookieChoiceKey);
  if (!existingChoice) {
    requestAnimationFrame(() => cookieBanner?.classList.add('is-visible'));
  } else {
    document.documentElement.dataset.cookieChoice = existingChoice;
  }
} catch {
  requestAnimationFrame(() => cookieBanner?.classList.add('is-visible'));
}

acceptCookies?.addEventListener('click', () => setCookieChoice('accepted'));
rejectCookies?.addEventListener('click', () => setCookieChoice('rejected'));

function setCookieChoice(choice) {
  try {
    localStorage.setItem(cookieChoiceKey, choice);
  } catch {
    // Browsers can block storage; still hide the banner for the current page.
  }
  document.documentElement.dataset.cookieChoice = choice;
  cookieBanner?.classList.remove('is-visible');
}
