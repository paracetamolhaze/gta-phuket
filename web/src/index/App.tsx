interface Surface {
  readonly href: string;
  readonly title: string;
  readonly note: string;
}

const SURFACES: readonly Surface[] = [
  { href: '/dev.html', title: 'Симулятор плеера', note: 'Локальный Twitch-плеер: оверлей, расширение, GPS, выкуп' },
  { href: '/streamer.html', title: 'Телефон стримера', note: 'Отдаёт GPS и закрывает выполненную точку' },
  { href: '/obs.html', title: 'Оверлей OBS', note: 'Прозрачный слой 1920×1080 для браузер-источника' },
  { href: '/admin.html', title: 'Пульт', note: 'Настройки, цены, слоты наград, отмена и возврат' },
];

export default function App(): JSX.Element {
  return (
    <main className="idx">
      <header className="idx-head">
        <h1 className="idx-title">IRL WAYPOINT</h1>
        <p className="idx-line">
          Зритель тратит баллы канала на точку на карте Пхукета — стример идёт туда пешком, маршрут и остаток пути видны
          в эфире.
        </p>
      </header>

      <nav className="idx-list" aria-label="Поверхности">
        {SURFACES.map((surface) => (
          <a key={surface.href} className="idx-item" href={surface.href}>
            <span className="idx-item-path mono">{surface.href}</span>
            <span className="idx-item-title">{surface.title}</span>
            <span className="idx-item-note">{surface.note}</span>
          </a>
        ))}
      </nav>

      <p className="idx-foot label">Расширение зрителя открывается внутри Twitch, а не отсюда</p>
    </main>
  );
}
