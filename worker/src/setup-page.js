// The setup instructions page served at GET / — same content as the team artifact.
export const SETUP_PAGE = `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Figmate Setup</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700&family=Golos+Text:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
  :root {
    --bg: #FAF8F8;
    --surface: #FFFFFF;
    --surface-2: #F3EEEE;
    --ink: #23191A;
    --muted: #756A6B;
    --line: #E7DEDE;
    --accent: #EB5757;
    --accent-deep: #D64545;
    --accent-soft: #FDEEEE;
    --ok: #0F8C4C;
    --warn: #A66E0A;
    --code-bg: #241D1E;
    --code-ink: #F4ECEC;
    --code-accent: #F49B9B;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #1C1718;
      --surface: #262021;
      --surface-2: #2F2728;
      --ink: #F2EDED;
      --muted: #A39597;
      --line: #3C3233;
      --accent: #F06B6B;
      --accent-deep: #EB5757;
      --accent-soft: #3A2526;
      --ok: #35C978;
      --warn: #E8A317;
      --code-bg: #171213;
      --code-ink: #F4ECEC;
      --code-accent: #F49B9B;
    }
  }
  :root[data-theme="dark"] {
    --bg: #1C1718;
    --surface: #262021;
    --surface-2: #2F2728;
    --ink: #F2EDED;
    --muted: #A39597;
    --line: #3C3233;
    --accent: #F06B6B;
    --accent-deep: #EB5757;
    --accent-soft: #3A2526;
    --ok: #35C978;
    --warn: #E8A317;
    --code-bg: #171213;
    --code-ink: #F4ECEC;
    --code-accent: #F49B9B;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: "Golos Text", "Helvetica Neue", Arial, sans-serif;
    font-size: 16px;
    line-height: 1.6;
  }
  .wrap {
    max-width: 760px;
    margin: 0 auto;
    padding: 48px 24px 96px;
  }

  header { margin-bottom: 40px; }
  .wordmark {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .wordmark h1 {
    font-family: "Unbounded", "Golos Text", sans-serif;
    font-weight: 700;
    font-size: clamp(28px, 5vw, 40px);
    letter-spacing: -0.01em;
    margin: 0;
    text-wrap: balance;
  }
  .wordmark .dot { color: var(--accent); }
  .tagline {
    color: var(--muted);
    margin: 10px 0 0;
    max-width: 56ch;
  }
  .chain {
    margin-top: 24px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-family: "JetBrains Mono", monospace;
    font-size: 13px;
  }
  .chain .node {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 14px;
    white-space: nowrap;
  }
  .chain .arrow { color: var(--accent); font-weight: 600; }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 20px;
    counter-reset: step;
  }
  .step {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 24px 28px;
  }
  .step-head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-bottom: 8px;
  }
  .step-head::before {
    counter-increment: step;
    content: counter(step);
    font-family: "Unbounded", sans-serif;
    font-weight: 500;
    font-size: 15px;
    color: var(--accent-deep);
    border: 1.5px solid var(--accent);
    border-radius: 50%;
    width: 32px;
    height: 32px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    transform: translateY(6px);
  }
  .step h2 {
    font-size: 20px;
    font-weight: 600;
    margin: 0;
    text-wrap: balance;
  }
  .step p { margin: 8px 0; max-width: 62ch; }
  .step .once {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin-left: auto;
    white-space: nowrap;
  }

  .menu-path {
    background: var(--surface-2);
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 14px;
    white-space: nowrap;
  }
  kbd {
    font-family: "JetBrains Mono", monospace;
    font-size: 13px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-bottom-width: 2px;
    border-radius: 5px;
    padding: 1px 7px;
  }
  a { color: var(--accent-deep); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .download {
    display: inline-block;
    margin: 10px 0 4px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 15px;
    border-radius: 8px;
    padding: 10px 22px;
    text-decoration: none;
  }
  .download:hover { background: var(--accent-deep); }

  .codeblock {
    position: relative;
    background: var(--code-bg);
    color: var(--code-ink);
    border-radius: 10px;
    margin: 14px 0;
    overflow-x: auto;
  }
  .codeblock pre {
    margin: 0;
    padding: 16px 96px 16px 18px;
    font-family: "JetBrains Mono", monospace;
    font-size: 13.5px;
    line-height: 1.6;
  }
  .codeblock .cm { color: var(--code-accent); }
  .copy {
    position: absolute;
    top: 10px;
    right: 10px;
    font-family: "Golos Text", sans-serif;
    font-size: 12px;
    font-weight: 600;
    color: var(--code-ink);
    background: rgba(255, 255, 255, 0.12);
    border: 0;
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
  }
  .copy:hover { background: var(--accent-deep); }

  .callout {
    display: flex;
    gap: 12px;
    background: var(--accent-soft);
    border-radius: 10px;
    padding: 14px 18px;
    margin: 14px 0 0;
    font-size: 15px;
  }
  .callout::before {
    content: "!";
    font-family: "Unbounded", sans-serif;
    font-weight: 700;
    color: var(--accent-deep);
    flex: none;
  }
  .callout p { margin: 0; }

  .status {
    font-weight: 600;
  }
  .status.ok { color: var(--ok); }

  section.extra { margin-top: 56px; }
  section.extra h2 {
    font-family: "Unbounded", sans-serif;
    font-weight: 500;
    font-size: 18px;
    margin: 0 0 16px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
    font-size: 15px;
  }
  .table-scroll { overflow-x: auto; border-radius: 12px; }
  th, td {
    text-align: left;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  tr:last-child td { border-bottom: 0; }
  th {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--surface-2);
  }
  td code, li code, p code {
    font-family: "JetBrains Mono", monospace;
    font-size: 13px;
    background: var(--surface-2);
    border-radius: 5px;
    padding: 1px 6px;
  }
  .usage li { margin: 6px 0; max-width: 62ch; }

  footer {
    margin-top: 56px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 14px;
  }
</style>
</head>
<body>

<div class="wrap">
  <header>
    <div class="wordmark">
      <h1>Figmate<span class="dot">.</span></h1>
    </div>
    <p class="tagline">Підключення Claude Code до Figma: агент читає й редагує макети через ваш плагін. Установка — один раз, хвилин на п'ять.</p>
    <div class="chain" aria-label="Ланцюг роботи">
      <span class="node">Claude Code</span>
      <span class="arrow">→</span>
      <span class="node">figmate worker</span>
      <span class="arrow">→</span>
      <span class="node">плагін у вашій Figma</span>
      <span class="arrow">→</span>
      <span class="node">файл</span>
    </div>
  </header>

  <div class="steps">
    <div class="step">
      <div class="step-head">
        <h2>Завантажте плагін</h2>
        <span class="once">один раз</span>
      </div>
      <p><a class="download" href="https://drive.google.com/file/d/1t_rSyhnJ3CefOtZNLavQrKXbhcnycVlh/view?usp=sharing" target="_blank" rel="noopener">Завантажити figmate-plugin.zip</a></p>
      <p>Розпакуйте архів у постійне місце — Figma читає dev-плагін з диска, тож папку потім не переносьте й не видаляйте:</p>
      <div class="codeblock">
        <pre>unzip ~/Downloads/figmate-plugin.zip -d ~/Work/figmate-plugin</pre>
        <button class="copy" type="button">Copy</button>
      </div>
    </div>

    <div class="step">
      <div class="step-head">
        <h2>Імпортуйте плагін у Figma Desktop</h2>
        <span class="once">один раз</span>
      </div>
      <p><span class="menu-path">Plugins → Development → Import plugin from manifest…</span></p>
      <p>Виберіть файл <code>~/Work/figmate-plugin/plugin/manifest.json</code>. Плагін з'явиться в меню як <strong>Figmate Bridge</strong>.</p>
    </div>

    <div class="step">
      <div class="step-head">
        <h2>Авторизуйтесь</h2>
        <span class="once">один раз</span>
      </div>
      <p>Запустіть плагін: <span class="menu-path">Plugins → Development → Figmate Bridge</span> — і натисніть кнопку <strong>Authorize</strong>.</p>
      <p>У браузері відкриється сторінка, де все вже підставлено з плагіна — введіть лише своє ім'я та натисніть <strong>Authorize</strong>. Плагін сам отримає персональний токен, і бар стане <span class="status ok">зеленим Connected</span>.</p>
      <div class="callout"><p>Токен запам'ятовується назавжди — повторно авторизуватись не треба ні в нових файлах, ні після перезапуску Figma.</p></div>
    </div>

    <div class="step">
      <div class="step-head">
        <h2>Дайте токен своєму Claude Code</h2>
        <span class="once">один раз</span>
      </div>
      <p>Та сама сторінка авторизації покаже готовий JSON з <code>FIGMATE_SERVER</code> і <code>FIGMATE_TOKEN</code>. Вставте його в <code>splynx/.claude/settings.local.json</code> (він gitignored):</p>
      <div class="codeblock">
        <pre>{
  <span class="cm">"env"</span>: {
    <span class="cm">"FIGMATE_SERVER"</span>: "https://figmate.rainoldweb.workers.dev",
    <span class="cm">"FIGMATE_TOKEN"</span>: "&lt;ваш токен зі сторінки&gt;"
  }
}</pre>
        <button class="copy" type="button">Copy</button>
      </div>
      <p>Альтернатива — глобально для всіх проєктів: той самий блок у <code>~/.claude/settings.json</code>.</p>
    </div>

    <div class="step">
      <div class="step-head">
        <h2>Поставте скіл агенту</h2>
        <span class="once">один раз</span>
      </div>
      <p>Скіл лежить у тому ж архіві та навчає Claude Code самостійно читати figma-лінки через figmate:</p>
      <div class="codeblock">
        <pre>mkdir -p ~/.claude/skills/figmate
cp ~/Work/figmate-plugin/skills/figmate/SKILL.md ~/.claude/skills/figmate/</pre>
        <button class="copy" type="button">Copy</button>
      </div>
      <p>Діє з наступної сесії Claude Code.</p>
    </div>
  </div>

  <section class="extra">
    <h2>Як користуватись</h2>
    <ul class="usage">
      <li>Киньте агенту лінк на ноду з Figma — він сам витягне id і прочитає дерево.</li>
      <li>Плагін працює з <strong>відкритим</strong> файлом: перейшли в інший файл — натисніть <kbd>⌥⌘P</kbd> (Run last plugin), і все.</li>
      <li>Файл, де у вас лише перегляд: зробіть <span class="menu-path">Duplicate to your drafts</span> і відкрийте копію — у ній плагін має повні права.</li>
      <li>«Подивись, що я виділив» теж працює — агент читає поточне виділення.</li>
    </ul>
  </section>

  <section class="extra">
    <h2>Якщо щось не так</h2>
    <div class="table-scroll">
      <table>
        <tr><th>Симптом</th><th>Причина</th><th>Що зробити</th></tr>
        <tr>
          <td><code>plugin not connected</code></td>
          <td>Плагін не запущений у поточному файлі</td>
          <td>Відкрийте файл у Figma → <kbd>⌥⌘P</kbd></td>
        </tr>
        <tr>
          <td>Бар «Slot busy»</td>
          <td>Плагін відкритий у другому вікні Figma</td>
          <td>Закрийте його там — цей перепідключиться сам</td>
        </tr>
        <tr>
          <td>Бар «Invalid token» / «Not authorized»</td>
          <td>Токен відкликано</td>
          <td>Плагін сам покаже кнопку Authorize — пройдіть ще раз і оновіть env</td>
        </tr>
        <tr>
          <td>Сторінка каже «wrong invite code»</td>
          <td>Застарілий архів плагіна</td>
          <td>Скачайте свіжий zip за лінком з кроку 1 і переімпортуйте плагін</td>
        </tr>
        <tr>
          <td>Агент отримує <code>401</code></td>
          <td>Порожній чи старий <code>FIGMATE_TOKEN</code> в env</td>
          <td>Звірте значення в <code>~/.claude/settings.json</code>, перезапустіть сесію</td>
        </tr>
        <tr>
          <td>Меню Plugins неактивне у файлі</td>
          <td>У файлі немає права редагування</td>
          <td><span class="menu-path">Duplicate to your drafts</span> → працюйте з копією</td>
        </tr>
      </table>
    </div>
  </section>

  <footer>
    Репозиторій: <a href="https://github.com/maximyaroshchuk/figmate">github.com/maximyaroshchuk/figmate</a> · сервер: figmate.rainoldweb.workers.dev · базується на <a href="https://github.com/denysosadchyi/figmosha2">figmosha2</a>
  </footer>
</div>

<script>
  document.querySelectorAll(".copy").forEach((button) => {
    button.addEventListener("click", () => {
      const text = button.parentElement.querySelector("pre").textContent;
      const done = () => {
        button.textContent = "Copied!";
        setTimeout(() => { button.textContent = "Copy"; }, 1500);
      };
      try {
        navigator.clipboard.writeText(text).then(done, () => {
          const range = document.createRange();
          range.selectNodeContents(button.parentElement.querySelector("pre"));
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand("copy");
          selection.removeAllRanges();
          done();
        });
      } catch (e) { /* clipboard unavailable — text stays selectable by hand */ }
    });
  });
</script>

</body>
</html>`;
