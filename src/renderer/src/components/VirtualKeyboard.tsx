/**
 * VirtualKeyboard — an on-screen keyboard/keypad for the touchscreen kiosk.
 *
 * Appears at the bottom of the screen whenever a text/number input or textarea
 * is focused. Number fields get a numeric keypad; text fields get a full
 * keyboard. Keys insert into the focused field (keeping it focused) and fire a
 * native input event so React's onChange updates state normally.
 *
 * Mounted once, globally, in App. Customer screens have no inputs, so it stays
 * hidden there; it only shows in the Admin panel.
 */

import { useEffect, useRef, useState } from 'react'

type Field = HTMLInputElement | HTMLTextAreaElement

const EDITABLE_INPUT_TYPES = ['text', 'number', 'password', 'search', 'tel', 'url', 'email']

function isEditable(el: Element | null): el is Field {
  if (!el) return false
  if (el.tagName === 'TEXTAREA') {
    const t = el as HTMLTextAreaElement
    return !t.disabled && !t.readOnly
  }
  if (el.tagName === 'INPUT') {
    const inp = el as HTMLInputElement
    return EDITABLE_INPUT_TYPES.includes((inp.type || 'text').toLowerCase()) && !inp.disabled && !inp.readOnly
  }
  return false
}

// Set an input's value so React's onChange fires (must go through the native setter).
function setNativeValue(el: Field, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export function VirtualKeyboard(): JSX.Element | null {
  const [target, setTarget] = useState<Field | null>(null)
  const [shift, setShift] = useState(false)
  const targetRef = useRef<Field | null>(null)
  useEffect(() => { targetRef.current = target }, [target])

  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      if (isEditable(e.target as Element)) {
        const el = e.target as Field
        setTarget(el)
        // Keep the focused field visible above the keyboard.
        setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
      }
    }
    // Keys preventDefault their pointerdown, so tapping the keyboard never blurs
    // the field. Focus only leaves when the user taps another (non-editable)
    // element — then hide.
    const onFocusOut = (): void => {
      setTimeout(() => {
        if (!isEditable(document.activeElement)) setTarget(null)
      }, 60)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  if (!target) return null

  const isNumber = (target.tagName === 'INPUT') && ((target as HTMLInputElement).type === 'number')

  const insert = (ch: string): void => {
    const el = targetRef.current
    if (!el) return
    if (isNumber) {
      // Number inputs don't support selection; append at the end.
      setNativeValue(el, (el.value ?? '') + ch)
    } else {
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      const next = el.value.slice(0, start) + ch + el.value.slice(end)
      setNativeValue(el, next)
      const pos = start + ch.length
      requestAnimationFrame(() => { try { el.setSelectionRange(pos, pos) } catch { /* ignore */ } el.focus() })
    }
  }

  const backspace = (): void => {
    const el = targetRef.current
    if (!el) return
    if (isNumber) {
      setNativeValue(el, (el.value ?? '').slice(0, -1))
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    if (start === end) {
      if (start === 0) return
      setNativeValue(el, el.value.slice(0, start - 1) + el.value.slice(end))
      const pos = start - 1
      requestAnimationFrame(() => { try { el.setSelectionRange(pos, pos) } catch { /* ignore */ } el.focus() })
    } else {
      setNativeValue(el, el.value.slice(0, start) + el.value.slice(end))
      requestAnimationFrame(() => { try { el.setSelectionRange(start, start) } catch { /* ignore */ } el.focus() })
    }
  }

  const done = (): void => { targetRef.current?.blur(); setTarget(null) }

  // Layouts
  const numRows = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['.', '0', '⌫']]
  const letterRows = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
    ['.', '@', '/', ':', '-', '_']
  ]

  const KEY_BASE: React.CSSProperties = {
    minWidth: 54, height: 58, borderRadius: 10,
    border: '1px solid rgba(201,162,39,0.4)', background: 'rgba(255,255,255,0.06)',
    color: 'var(--text-white)', fontSize: '1.3rem', cursor: 'pointer', userSelect: 'none'
  }
  const Key = ({ label, onTap, style, flex }: { label: string; onTap: () => void; style?: React.CSSProperties; flex?: number }): JSX.Element => (
    <button
      // preventDefault keeps the focused input from blurring when a key is tapped
      onPointerDown={(e) => { e.preventDefault(); onTap() }}
      style={{ ...KEY_BASE, ...(flex ? { flex } : {}), ...style }}
    >
      {label}
    </button>
  )

  return (
    <div
      onPointerDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 2000,
        background: 'rgba(8,16,34,0.98)', borderTop: '1px solid rgba(201,162,39,0.35)',
        boxShadow: '0 -8px 30px rgba(0,0,0,0.5)', padding: '12px 14px 16px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8
      }}
    >
      {isNumber ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 300 }}>
          {numRows.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 8 }}>
              {row.map((k) => (
                <Key key={k} label={k} flex={1} style={{ height: 62 }} onTap={() => (k === '⌫' ? backspace() : insert(k))} />
              ))}
            </div>
          ))}
          <button
            onPointerDown={(e) => { e.preventDefault(); done() }}
            style={{ ...KEY_BASE, height: 52, background: 'linear-gradient(135deg, var(--accent-gold), var(--accent-gold-dark))', color: '#1a1205', fontWeight: 800, border: 'none' }}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          {letterRows.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
              {ri === 3 && <Key label="⇧" onTap={() => setShift((s) => !s)} style={{ minWidth: 70, background: shift ? 'rgba(201,162,39,0.3)' : KEY_BASE.background }} />}
              {row.map((k) => {
                const label = shift && /[a-z]/.test(k) ? k.toUpperCase() : k
                return <Key key={k} label={label} onTap={() => insert(label)} />
              })}
              {ri === 3 && <Key label="⌫" onTap={backspace} style={{ minWidth: 70 }} />}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', width: '100%', maxWidth: 640 }}>
            <Key label="Space" onTap={() => insert(' ')} flex={4} />
            <Key label="Done" onTap={done} flex={1} style={{ background: 'linear-gradient(135deg, var(--accent-gold), var(--accent-gold-dark))', color: '#1a1205', fontWeight: 800, border: 'none' }} />
          </div>
        </>
      )}
    </div>
  )
}
