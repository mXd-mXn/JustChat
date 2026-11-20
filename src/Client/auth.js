if (sessionStorage.getItem('justchat_user')) {
  window.location.href = '/';
}

const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const authError = document.getElementById('auth-error');

tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active');
  tabRegister.classList.remove('active');
  loginForm.classList.remove('hidden');
  registerForm.classList.add('hidden');
  authError.textContent = '';
});

tabRegister.addEventListener('click', () => {
  tabRegister.classList.add('active');
  tabLogin.classList.remove('active');
  registerForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
  authError.textContent = '';
});

async function sendAuthRequest(url, payload, submitBtn) {
  authError.textContent = '';
  submitBtn.disabled = true;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      authError.textContent = data.error || 'Помилка авторизації';
      return;
    }

    sessionStorage.setItem('justchat_user', JSON.stringify(data.user));
    window.location.href = '/';
  } catch {
    authError.textContent = 'Не вдалося з’єднатися із сервером';
  } finally {
    submitBtn.disabled = false;
  }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const submitBtn = loginForm.querySelector('button[type="submit"]');

  sendAuthRequest('/api/login', { username, password }, submitBtn);
});

registerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const submitBtn = registerForm.querySelector('button[type="submit"]');

  if (!email.toLowerCase().endsWith('@proton.me')) {
    authError.textContent = 'Потрібна пошта у форматі @proton.me';
    return;
  }

  sendAuthRequest('/api/register', { username, email, password }, submitBtn);
});