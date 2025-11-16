import TextareaAutosize from 'react-textarea-autosize';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props} className={`w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm focus-ring ${props.className||''}`} />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxRows?: number }) {
  const { minRows = 3, maxRows = 10, className, ...rest } = props as any;
  return (
    <TextareaAutosize minRows={minRows} maxRows={maxRows} {...rest} className={`w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm focus-ring ${className||''}`} />
  );
}
