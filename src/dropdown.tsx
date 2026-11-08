import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import './dropdown.css';

export function Dropdown({ label, value, options, onChange, up = false }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; up?: boolean }) {
  const id = useId(), root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  const [open, setOpen] = useState(false), [active, setActive] = useState(selected);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const choose = (index: number) => { onChange(options[index].value); setOpen(false); button.current?.focus(); };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setOpen(true);
      setActive(open ? (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : selected); return;
    }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setOpen(true); setActive(event.key === 'Home' ? 0 : options.length - 1); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (open) choose(active); else { setActive(selected); setOpen(true); } return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const index = options.findIndex(option => option.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (index >= 0) { event.preventDefault(); setActive(index); setOpen(true); }
    }
  };
  return <div className={`tt-dropdown ${up ? 'opens-up' : ''}`} ref={root}>
    <button ref={button} id={`${id}-trigger`} className="tt-dropdown-trigger" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open ? `${id}-option-${active}` : undefined} onKeyDown={key} onBlur={event => { if (!root.current?.contains(event.relatedTarget)) setOpen(false); }} onClick={() => { button.current?.focus(); setActive(selected); setOpen(!open); }}>
      <span>{options[selected].label}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>
    {open && <div id={`${id}-list`} className="tt-dropdown-menu" role="listbox" aria-label={label}>
      {options.map((option, index) => <button key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} tabIndex={-1} className={index === active ? 'highlighted' : ''} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value && <Check size={14} aria-hidden="true"/>}
      </button>)}
    </div>}
  </div>;
}
