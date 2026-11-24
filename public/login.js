// Shows why the last sign-in attempt failed (CSP forbids inline scripts).
const e = new URLSearchParams(location.search).get('e');
if (e) {
  const el = document.getElementById('err');
  el.textContent = e === 'locked' ? 'Too many attempts. Try again in 15 minutes.' : 'Wrong password.';
  el.hidden = false;
}
