export function ChromeSculpture() {
  return (
    <svg viewBox="0 0 600 520" className="sculpture" aria-hidden="true">
      <defs>
        <linearGradient id="pickup-chrome-metal" x1="0" y1="0" x2=".8" y2="1">
          <stop stopColor="#ffffff" />
          <stop offset=".19" stopColor="#dddeda" />
          <stop offset=".29" stopColor="#fff" />
          <stop offset=".39" stopColor="#666f71" />
          <stop offset=".48" stopColor="#19262d" />
          <stop offset=".52" stopColor="#f7f9fa" />
          <stop offset=".61" stopColor="#adb4b6" />
          <stop offset=".7" stopColor="#fff" />
          <stop offset=".82" stopColor="#4b5358" />
          <stop offset="1" stopColor="#dce0e0" />
        </linearGradient>
        <filter id="pickup-chrome-shadow">
          <feGaussianBlur stdDeviation="11" />
        </filter>
        <linearGradient id="pickup-chrome-edge">
          <stop stopColor="#30383c" />
          <stop offset=".5" stopColor="#fff" />
          <stop offset="1" stopColor="#60696b" />
        </linearGradient>
      </defs>
      <ellipse
        cx="322"
        cy="447"
        rx="161"
        ry="17"
        fill="#303b43"
        opacity=".19"
        filter="url(#pickup-chrome-shadow)"
      />
      <g transform="rotate(-28 305 260)">
        <ellipse
          cx="300"
          cy="240"
          rx="176"
          ry="109"
          fill="none"
          stroke="url(#pickup-chrome-metal)"
          strokeWidth="71"
        />
        <ellipse
          cx="300"
          cy="246"
          rx="177"
          ry="108"
          fill="none"
          stroke="url(#pickup-chrome-edge)"
          strokeWidth="1.5"
        />
        <ellipse
          cx="300"
          cy="237"
          rx="140"
          ry="74"
          fill="none"
          stroke="#263238"
          strokeWidth="1"
          strokeOpacity=".55"
        />
        {Array.from({ length: 26 }, (_, i) => (
          <ellipse
            key={i}
            cx="300"
            cy={211 + i * 2.05}
            rx={153 + Math.sin((i / 26) * Math.PI) * 24}
            ry={82 + Math.sin((i / 26) * Math.PI) * 26}
            fill="none"
            stroke={i % 3 === 0 ? "#fff" : "#647173"}
            strokeOpacity={i % 3 === 0 ? ".28" : ".11"}
            strokeWidth=".6"
          />
        ))}
      </g>
      <g transform="translate(88 182) rotate(34 190 112)">
        <ellipse
          cx="190"
          cy="112"
          rx="144"
          ry="76"
          fill="none"
          stroke="url(#pickup-chrome-metal)"
          strokeWidth="51"
        />
        <ellipse
          cx="190"
          cy="112"
          rx="144"
          ry="76"
          fill="none"
          stroke="#ffffff"
          strokeWidth="1.2"
          strokeOpacity=".7"
        />
      </g>
      <path
        d="M414 75h71v65M105 370v56h60"
        fill="none"
        stroke="#59666a"
        strokeWidth=".8"
      />
      <text
        x="414"
        y="63"
        fontFamily="monospace"
        fontSize="9"
        fill="#657175"
        letterSpacing="2"
      >
        CONTINUITY OBJECT
      </text>
    </svg>
  );
}
