import { AVATAR_COLORS, AVATAR_EMOJI, type Avatar } from "@throne/shared";

/** Spoken names for the palette (same order as AVATAR_COLORS). */
const COLOR_NAMES: Record<(typeof AVATAR_COLORS)[number], string> = {
  "#7c5cff": "violet", "#e8590c": "orange", "#2b8a3e": "green", "#1c7ed6": "blue",
  "#d6336c": "pink", "#f0b400": "yellow", "#0c8599": "teal", "#868e96": "gray",
};

/** Pick an Avatar: an emoji from the fixed list on a color from the palette of 8. */
export function AvatarPicker({ value, onChange }: { value: Avatar; onChange: (a: Avatar) => void }) {
  return (
    <div className="avatar-picker">
      <span className="avatar big" style={{ background: value.color }} aria-hidden="true">{value.emoji}</span>
      <div role="radiogroup" aria-label="Avatar emoji" className="choices">
        {AVATAR_EMOJI.map((emoji) => (
          <button key={emoji} type="button" role="radio" aria-checked={value.emoji === emoji} aria-label={emoji}
            className="choice emoji" onClick={() => onChange({ ...value, emoji })}>
            {emoji}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Avatar color" className="choices">
        {AVATAR_COLORS.map((color) => (
          <button key={color} type="button" role="radio" aria-checked={value.color === color} aria-label={COLOR_NAMES[color]}
            className="choice swatch" style={{ background: color }} onClick={() => onChange({ ...value, color })} />
        ))}
      </div>
    </div>
  );
}
