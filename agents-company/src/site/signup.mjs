// Prepares an AI-written landing page for the public web:
//  - strips any scripts the model wrote (we only ship our own, reviewed code)
//  - injects a small script that wires the page's email form to the company's
//    /signup endpoint (with consent checkbox and spam honeypot) and sends one
//    anonymous page-view beacon to /event
//  - builds a plain privacy notice published next to the page
// Nothing here is legal advice; have the privacy text reviewed for your country.

const PAGE_RE = /^[a-z0-9-]{1,60}$/;

export function validateSignupUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`AGENTS_SIGNUP_URL is not a valid URL: "${url}"`); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    throw new Error('AGENTS_SIGNUP_URL must use https:// (GitHub Pages is HTTPS, and browsers block insecure form posts from it)');
  }
  return u.toString().replace(/\/$/, '');
}

export function stripScripts(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\s(href|src|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, ' $1="#"');
}

export function injectSignup(html, { endpoint, page }) {
  if (!PAGE_RE.test(page)) throw new Error(`Invalid page id "${page}"`);
  const base = validateSignupUrl(endpoint);
  const script = `<script data-agents-company>${signupScript(base, page)}</script>`;
  const clean = stripScripts(html);
  return /<\/body\s*>/i.test(clean) ? clean.replace(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i, `${script}\n</body>`) : `${clean}\n${script}\n`;
}

// Kept dependency-free and small; values are embedded with JSON.stringify and
// "</" is escaped so they cannot close the script tag.
function signupScript(endpoint, page) {
  const E = JSON.stringify(endpoint).replace(/<\//g, '<\\/');
  const P = JSON.stringify(page);
  return `(function(){var E=${E},P=${P};
try{navigator.sendBeacon&&navigator.sendBeacon(E+"/event",JSON.stringify({page:P,type:"view"}))}catch(e){}
var forms=document.querySelectorAll("form[data-signup]");if(!forms.length)forms=document.querySelectorAll("form");
Array.prototype.forEach.call(forms,function(f){
var email=f.querySelector("input[type=email],input[name=email]");if(!email)return;
f.setAttribute("action","#");f.setAttribute("method","post");email.setAttribute("required","");
var consent=f.querySelector("input[name=consent]");
if(!consent){var l=document.createElement("label");l.style.display="block";l.style.margin="8px 0";
consent=document.createElement("input");consent.type="checkbox";consent.name="consent";consent.required=true;
var a=document.createElement("a");a.href="privacy.html";a.textContent="privacy notice";
l.appendChild(consent);l.appendChild(document.createTextNode(" I agree to receive emails about this project. You can unsubscribe at any time. See the "));l.appendChild(a);l.appendChild(document.createTextNode("."));
var btn=f.querySelector("button,input[type=submit]");btn?f.insertBefore(l,btn):f.appendChild(l)}
var hp=document.createElement("input");hp.type="text";hp.name="website";hp.tabIndex=-1;hp.autocomplete="off";
hp.setAttribute("aria-hidden","true");hp.style.cssText="position:absolute;left:-9999px;height:0;width:0;opacity:0";f.appendChild(hp);
var msg=document.createElement("p");msg.setAttribute("role","status");f.appendChild(msg);
f.addEventListener("submit",function(ev){ev.preventDefault();
if(!consent.checked){msg.textContent="Please tick the consent box.";return}
msg.textContent="Sending...";
fetch(E+"/signup",{method:"POST",headers:{"content-type":"text/plain"},body:JSON.stringify({page:P,email:email.value,consent:true,website:hp.value})})
.then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})})
.then(function(x){msg.textContent=x.ok?(x.d&&x.d.message)||"Thanks! You're on the list.":(x.d&&x.d.error)||"Something went wrong, please try again.";if(x.ok)f.reset()})
.catch(function(){msg.textContent="Network error, please try again."})})});})();`;
}

export function privacyPage({ businessName, contactEmail, opportunity }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const who = esc(businessName || 'The operator of this page');
  const contact = contactEmail ? `<a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a>` : 'the contact address on the main page';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy notice</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#222}h1{font-size:1.6em}</style>
</head><body>
<h1>Privacy notice</h1>
<p><strong>${who}</strong> runs this page${opportunity ? ` about <em>${esc(opportunity)}</em>` : ''}.</p>
<h2>What we collect</h2>
<p>If you sign up, we store your email address, the page you signed up on, the time, and the fact that you gave consent.
We also count page views per day. Those counts do not include your IP address or any identifier.</p>
<h2>Why</h2>
<p>To send you updates about this project, which is what you asked for when you ticked the consent box. The legal basis is your consent.</p>
<h2>How long</h2>
<p>Until you unsubscribe or ask us to delete it. We do not sell or share your email address.</p>
<h2>Your rights</h2>
<p>You can ask to see, correct or delete your data, or withdraw consent at any time, by contacting ${contact}.
Every email we send includes an unsubscribe option.</p>
<p><a href="./">Back</a></p>
</body></html>
`;
}
