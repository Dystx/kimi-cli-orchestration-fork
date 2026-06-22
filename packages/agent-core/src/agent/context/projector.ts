import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

import { ErrorCodes, KimiError } from '../../errors';
import type { ContextMessage } from './types';

export function project(history: readonly ContextMessage[]): Message[] {
  return mergeAdjacentUserMessages(history);
}

function mergeAdjacentUserMessages(history: readonly ContextMessage[]): Message[] {
  const out: ContextMessage[] = [];
  for (const source of history) {
    const message = prepareMessageForProjection(source);
    if (message === null) continue;

    const previous = out.at(-1);
    if (
      canMergeUserMessage(message) &&
      previous !== undefined &&
      canMergeUserMessage(previous)
    ) {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    out.push(message);
  }
  return out.map(stripContextMetadata);
}

function prepareMessageForProjection(message: ContextMessage): ContextMessage | null {
  if (message.partial === true) return null;

  let content: ContentPart[] | undefined;
  for (const [index, part] of message.content.entries()) {
    if (part.type === 'text' && part.text.length === 0) {
      content ??= message.content.slice(0, index);
      continue;
    }
    content?.push(part);
  }

  const next = content === undefined ? message : { ...message, content };
  if (next.role === 'tool' && next.content.length === 0) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      'Tool result message content cannot be empty after removing empty text blocks.',
      {
        details: {
          toolCallId: next.toolCallId,
        },
      },
    );
  }
  return next.content.length === 0 && next.toolCalls.length === 0 ? null : next;
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
    origin: a.origin,
  };
}

function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}

export function trimTrailingOpenToolExchange(history: readonly Message[]): Message[] {
  const resultIds = new Set<string>();
  let firstIncompleteIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === 'tool' && message.toolCallId) {
      resultIds.add(message.toolCallId);
    } else if (message.role === 'assistant' && message.toolCalls.length > 0) {
      if (!message.toolCalls.every((tc) => resultIds.has(tc.id))) {
        firstIncompleteIndex = i;
      }
    }
  }
  return firstIncompleteIndex === -1 ? [...history] : history.slice(0, firstIncompleteIndex);
}
