import type { ChangeEvent, InputHTMLAttributes, ReactNode } from "react"

type SettingsSwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "children"> & {
  label: ReactNode
  onCheckedChange: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void
  onText?: string
  offText?: string
}

export function SettingsSwitch({
  label,
  checked,
  disabled,
  onCheckedChange,
  onText = "开启",
  offText = "关闭",
  className,
  ...inputProps
}: SettingsSwitchProps): JSX.Element {
  const isChecked = Boolean(checked)

  return (
    <label
      className={["settings-switch", className].filter(Boolean).join(" ")}
      data-checked={isChecked ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
    >
      <input
        {...inputProps}
        className="settings-switch-input"
        type="checkbox"
        role="switch"
        checked={isChecked}
        disabled={disabled}
        aria-checked={isChecked}
        onChange={(event) => onCheckedChange(event.target.checked, event)}
      />
      <span className="settings-switch-control" aria-hidden="true">
        <span className="settings-switch-thumb" />
      </span>
      <span className="settings-switch-copy">
        <span className="settings-switch-label">{label}</span>
        <span className="settings-switch-state">{isChecked ? onText : offText}</span>
      </span>
    </label>
  )
}
