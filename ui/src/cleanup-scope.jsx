import { Check } from "lucide-react";

export default function CleanupScope({ checked, disabled, onClick, text, title }) {
  return <button aria-pressed={checked} className={`scope-card ${checked ? "scope-card-active" : ""}`} disabled={disabled} onClick={onClick} type="button"><div className="scope-heading"><span>{title}</span><span className="scope-check">{checked && <Check size={12} strokeWidth={3}/>}</span></div><p>{text}</p></button>;
}
