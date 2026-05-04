const { ipcRenderer } = require('electron');

document.getElementById('open-dashboard').addEventListener('click', () => {
  ipcRenderer.send('open-spotify-dashboard');
});

document.getElementById('submit-btn').addEventListener('click', submit);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});

function submit() {
  const clientId     = document.getElementById('client-id').value.trim();
  const clientSecret = document.getElementById('client-secret').value.trim();
  const errEl        = document.getElementById('error-msg');

  if (!clientId || !clientSecret) {
    errEl.textContent = '모든 항목을 입력해주세요';
    return;
  }

  if (clientId.length !== 32 || clientSecret.length !== 32) {
    errEl.textContent = 'Client ID / Secret은 각각 32자리입니다';
    return;
  }

  errEl.textContent = '';
  document.getElementById('submit-btn').textContent = '연결 중...';
  document.getElementById('submit-btn').disabled = true;

  ipcRenderer.send('setup-submit', { clientId, clientSecret });
}
