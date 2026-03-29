import React from 'react';

type TextTranslator = (text: string) => string;

const ATTRS_TO_TRANSLATE = ['placeholder', 'title', 'aria-label', 'alt', 'label'] as const;

let runtimeTranslator: TextTranslator = (text) => text;
let reactPatched = false;
let dialogPatched = false;

const withWhitespacePreserved = (input: string, mapper: (trimmed: string) => string) => {
  const match = input.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!match) return mapper(input);
  const [, leading, core, trailing] = match;
  if (!core) return input;
  return `${leading}${mapper(core)}${trailing}`;
};

const translateText = (input: string) => withWhitespacePreserved(input, runtimeTranslator);

const translateChild = (child: unknown): unknown => {
  if (typeof child === 'string') return translateText(child);
  if (Array.isArray(child)) return child.map((entry) => translateChild(entry));
  return child;
};

const translateProps = (props: Record<string, unknown> | null | undefined) => {
  if (!props) return props;
  let changed = false;
  const next: Record<string, unknown> = { ...props };

  for (const attr of ATTRS_TO_TRANSLATE) {
    const current = next[attr];
    if (typeof current === 'string') {
      const translated = translateText(current);
      if (translated !== current) {
        next[attr] = translated;
        changed = true;
      }
    }
  }

  return changed ? next : props;
};

export const setRuntimeTextTranslator = (translator: TextTranslator) => {
  runtimeTranslator = translator;
};

export const patchReactForAutoTranslation = () => {
  if (reactPatched) return;
  reactPatched = true;

  const originalCreateElement = React.createElement;
  (React as any).createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    const translatedProps = translateProps(props);
    const translatedChildren = children.map((child) => translateChild(child));
    return originalCreateElement(type as any, translatedProps as any, ...translatedChildren);
  };
};

export const patchBrowserDialogsForAutoTranslation = () => {
  if (dialogPatched || typeof window === 'undefined') return;
  dialogPatched = true;

  const originalAlert = window.alert.bind(window);
  const originalConfirm = window.confirm.bind(window);
  const originalPrompt = window.prompt.bind(window);

  window.alert = (message?: unknown) => originalAlert(typeof message === 'string' ? translateText(message) : message as any);
  window.confirm = (message?: string) => originalConfirm(typeof message === 'string' ? translateText(message) : message as any);
  window.prompt = (message?: string, defaultValue?: string) => {
    const translatedMessage = typeof message === 'string' ? translateText(message) : message;
    return originalPrompt(translatedMessage as any, defaultValue);
  };
};
