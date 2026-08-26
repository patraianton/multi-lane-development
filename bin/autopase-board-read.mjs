// autopase-board-read — доска «Autopase в одном месте» в командной строке.
//
// Тонкая обёртка над ручкой GET /api/board живого сервера доски: своей логики
// здесь нет, весь состав ответа считает сервер (bin/autopase-board.mjs). Нужна
// затем, чтобы агент-сторож читал доску одной командой, без браузера и без
// снимков экрана.
//
// Запуск: node bin\autopase-board-read.mjs [--json] [--full] [--card <имя>]
//         (или bin\autopase-board-read.cmd)
// Порт берётся из AUTOPASE_BOARD_PORT, по умолчанию 4878 — тот же, что у сервера.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0';
const PORT = Number(process.env.AUTOPASE_BOARD_PORT || 4878);
const BASE = `http://127.0.0.1:${PORT}`;
const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DESCRIPTION = 'доска «Autopase в одном месте»: окна herdr, полосы, PR и кто ждёт слова';

// Путь до себя с домашней папкой, свёрнутой в «~»: агенту достаточно понять,
// какой именно файл он запустил, полный путь до дома тут только шум.
function selfPath() {
  const p = path.join(path.dirname(SELF), 'autopase-board-read.cmd');
  if (HOME && p.toLowerCase().startsWith(HOME.toLowerCase())) return '~' + p.slice(HOME.length);
  return p;
}

const CMD = 'bin\\autopase-board-read.cmd';

const HELP = `bin: ${selfPath()}
description: ${DESCRIPTION}

Без флагов печатает живую доску коротким текстом (по мотивам TOON).

Флаги:
  --json          тот же состав аккуратным JSON
  --full          длинные тексты целиком (без обрезания)
  --card <имя>    одна карточка целиком: её последние слова, причина ожидания,
                  вопрос из зонтика. Имя — из клетки name раздела cards
  --help          эта справка
  --version       номер версии

Что в ответе:
  summary     счётчики: окон, ждут слова, полос пишут, PR открытых, ручных, скрытых
  cards       по карточке на строку, поля:
                column  колонка доски: ask — нужен CTO или владелец, running — в работе,
                        waiting — окно молчит, но полоса пишет, idle — простаивает,
                        off — окно без агента
                name    имя окна (или заголовок карточки, вписанной руками)
                state   состояние агента: working, idle, blocked, done, unknown, вручную
                ask     ждёт ли окно слова CTO или владельца: да / нет
                pr      самый свежий открытый PR окна и цвет его CI, «+N» — сколько ещё
                lanes   занятые полосы окна, «полоса-хост/lane-N»
  asks        почему окно ждёт слова; в клетке question — ссылка на зонтик
  questions   вопросы из зонтичных issue, по разу на зонтик (на них ссылается asks)
  words       начало последних слов каждого окна и откуда они взяты; целиком —
              ${CMD} --card <имя> или --full
  problems    источники доски, которые не ответили (ssh, gh). Пусто — значит всё живо

Примеры:
  ${CMD}
  ${CMD} --full
  ${CMD} --json
  ${CMD} --card cards-popular-001
`;

const KNOWN = new Set(['--json', '--full', '--card', '--help', '-h', '--version', '-v', '-V']);

const args = process.argv.slice(2);
// Про --json надо знать ещё до первой ошибки: агент, попросивший JSON, обязан
// получить JSON и в беде тоже, иначе он споткнётся на разборе вместо того,
// чтобы прочитать, что случилось.
const wantJson = args.includes('--json');

function die(text, code) {
  const out = wantJson ? asJson(text) : text;
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  process.exit(code);
}

// Наши сообщения устроены одинаково: строка «ошибка: …» и строка «help: …».
// В JSON они становятся двумя полями — читать их машине так же просто, как
// человеку строчки.
function asJson(text) {
  const lines = String(text).split('\n');
  const err = lines.find(l => l.startsWith('ошибка:')) ?? lines[0] ?? '';
  const help = lines.find(l => l.startsWith('help:')) ?? '';
  return JSON.stringify({
    error: err.replace(/^ошибка:\s*/, ''),
    help: help.replace(/^help:\s*/, '') || undefined,
  }, null, 2);
}

let wantCard = null;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (!KNOWN.has(a)) {
    die(`ошибка: непонятный флаг ${a}\n`
      + `help: у ${CMD} есть только --json, --full, --card <имя>, --help, --version`, 2);
  }
  if (a === '--card') {
    wantCard = args[i + 1] ?? '';
    i += 1;
    if (!wantCard || wantCard.startsWith('--')) {
      die('ошибка: у --card не указано имя карточки\n'
        + `help: ${CMD} --card <имя из клетки name раздела cards>`, 2);
    }
  }
}
if (args.includes('--help') || args.includes('-h')) die(HELP, 0);
if (args.includes('--version') || args.includes('-v') || args.includes('-V')) die(VERSION, 0);

const wantFull = args.includes('--full');
if (wantCard && wantFull) {
  die('ошибка: --full вместе с --card не нужен\n'
    + 'help: одна карточка и так печатается целиком, без обрезания', 2);
}

const format = `format=${wantJson ? 'json' : 'toon'}`;
const url = wantCard
  ? `${BASE}/api/board/card/${encodeURIComponent(wantCard)}?${format}`
  : `${BASE}/api/board?${format}${wantFull ? '&full=1' : ''}`;

let res;
try {
  res = await fetch(url, { signal: AbortSignal.timeout(180000) });
} catch (e) {
  // Сервера нет, он ещё поднимается или собирает доску дольше трёх минут —
  // это три разных беды, и лечатся они по-разному.
  const kind = String(e?.name || '');
  if (kind === 'TimeoutError' || kind === 'AbortError') {
    die(`ошибка: доска на ${BASE} не ответила за 3 минуты\n`
      + 'help: посмотри окно, где запущен bin\\autopase-board.cmd — источник мог зависнуть', 1);
  }
  die(`ошибка: доска не запущена (${BASE} не отвечает)\n`
    + 'help: запусти bin\\autopase-board.cmd и повтори команду', 1);
}

const body = await res.text();
if (!res.ok) {
  // 404 на нашей ручке значит, что на порту сидит доска, поднятая до появления
  // /api/board (или вообще другая программа). Пересказывать её тело нельзя:
  // агент получит чужой JSON вместо действия, которое ему надо сделать.
  if (res.status === 404 && !wantCard) {
    die(`ошибка: на ${BASE} доска запущена со старой сборки — ручки /api/board в ней нет\n`
      + 'help: закрой её окно и запусти заново bin\\autopase-board.cmd', 1);
  }
  const type = String(res.headers.get('content-type') || '');
  // Свою ошибку доска отдаёт обычным текстом по-русски — её и печатаем как
  // есть. Всё остальное (JSON, HTML, страница чужой программы) наружу не
  // пропускаем: агенту нужно действие, а не сырое тело зависимости.
  if (type.startsWith('text/plain') && body.trim().startsWith('ошибка:')) {
    die(body.trim(), 1);
  }
  die(`ошибка: доска на ${BASE} ответила кодом ${res.status} и ответом не про доску\n`
    + 'help: проверь, что на порту именно bin\\autopase-board.cmd, и перезапусти его', 1);
}

// Кто мы и о чём мы — до живых данных: агент, увидевший ответ без вопроса,
// должен понять, что это за вывод. С --json шапки нет: там ответ обязан
// разбираться как JSON целиком, и две лишние строки его сломали бы.
if (!wantJson) process.stdout.write(`bin: ${selfPath()}\ndescription: ${DESCRIPTION}\n`);
process.stdout.write(body.endsWith('\n') ? body : body + '\n');
