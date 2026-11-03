import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { RichTextEditor } from '@mantine/tiptap';
import { IconMathFunction, IconPhoto } from '@tabler/icons-react';
import { Node, mergeAttributes } from '@tiptap/core';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useId, useRef, useState } from 'react';
import type { Inline, RichText } from '../../../core/richtext';
import { call } from '../api';
import { notifyError, renderLatex, richHtml } from '../lib';
import { docToRich, richToDoc } from './richDoc';

/** Inline atom holding an image, equation or table token, rendered with the shared serializer. */
const RichAtom = Node.create({
  name: 'richAtom',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { data: { default: '{}' } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-rich-atom]',
        getAttrs: (el) => ({ data: (el as HTMLElement).getAttribute('data-rich-atom') ?? '{}' }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-rich-atom': HTMLAttributes.data, class: 'rich-atom' })];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.className = 'rich-atom';
      dom.contentEditable = 'false';
      try {
        const inline = JSON.parse(String(node.attrs.data)) as Inline;
        dom.innerHTML = richHtml([inline]);
        dom.title =
          inline.t === 'math'
            ? 'Equation (double-click to edit)'
            : inline.t === 'img'
              ? 'Image'
              : 'Table';
        dom.dataset.kind = inline.t;
      } catch {
        dom.textContent = '[?]';
      }
      return { dom };
    };
  },
});

export interface RichEditorProps {
  label: string;
  value: RichText;
  onChange: (value: RichText) => void;
  minHeight?: number;
  /** Compact single-line style for options. */
  compact?: boolean;
  error?: string | null;
}

export function RichEditor({
  label,
  value,
  onChange,
  minHeight = 70,
  compact = false,
  error,
}: RichEditorProps) {
  const labelId = useId();
  const [mathOpen, setMathOpen] = useState(false);
  const [latex, setLatex] = useState('');
  const editingPos = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastEmitted = useRef<string>(JSON.stringify(value));

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: false,
        strike: false,
      }),
      Subscript,
      Superscript,
      RichAtom,
    ],
    content: richToDoc(value),
    editorProps: {
      attributes: {
        'aria-labelledby': labelId,
        'aria-multiline': 'true',
        role: 'textbox',
        style: `min-height: ${minHeight}px`,
      },
      handleDoubleClickOn: (_view, pos, node) => {
        if (node.type.name !== 'richAtom') return false;
        const inline = JSON.parse(String(node.attrs.data)) as Inline;
        if (inline.t !== 'math') return false;
        editingPos.current = pos;
        setLatex(inline.latex ?? '');
        setMathOpen(true);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const next = docToRich(e.getJSON());
      lastEmitted.current = JSON.stringify(next);
      onChange(next);
    },
  });

  // Replace content when the value changes from outside (e.g. switching review items).
  useEffect(() => {
    if (!editor) return;
    const incoming = JSON.stringify(value);
    if (incoming !== lastEmitted.current) {
      lastEmitted.current = incoming;
      editor.commands.setContent(richToDoc(value), { emitUpdate: false });
    }
  }, [editor, value]);

  const insertAtom = (e: Editor, inline: Inline): void => {
    e.chain()
      .focus()
      .insertContent({ type: 'richAtom', attrs: { data: JSON.stringify(inline) } })
      .run();
  };

  const onImage = async (file: File | undefined): Promise<void> => {
    if (!file || !editor) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { ref } = await call('images:put', { bytes });
      insertAtom(editor, { t: 'img', ref });
    } catch (err) {
      notifyError(err, 'The image could not be added');
    }
  };

  const saveMath = (): void => {
    if (!editor || !latex.trim()) return setMathOpen(false);
    const inline: Inline = { t: 'math', latex: latex.trim() };
    if (editingPos.current !== null) {
      editor.chain().focus().setNodeSelection(editingPos.current).deleteSelection().run();
      editingPos.current = null;
    }
    insertAtom(editor, inline);
    setMathOpen(false);
    setLatex('');
  };

  let preview: string;
  try {
    preview = latex.trim() ? renderLatex(latex, false) : '';
  } catch {
    preview = '';
  }

  return (
    <Stack gap={4} className={compact ? 'rich-editor compact' : 'rich-editor'}>
      <Text id={labelId} size="sm" fw={500}>
        {label}
      </Text>
      <RichTextEditor editor={editor} aria-invalid={!!error}>
        <RichTextEditor.Toolbar>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Bold />
            <RichTextEditor.Italic />
            <RichTextEditor.Underline />
            <RichTextEditor.Subscript />
            <RichTextEditor.Superscript />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Control
              onClick={() => fileInput.current?.click()}
              aria-label="Insert image"
              title="Insert image"
            >
              <IconPhoto size={16} stroke={1.6} aria-hidden />
            </RichTextEditor.Control>
            <RichTextEditor.Control
              onClick={() => {
                editingPos.current = null;
                setLatex('');
                setMathOpen(true);
              }}
              aria-label="Insert equation"
              title="Insert equation (LaTeX)"
            >
              <IconMathFunction size={16} stroke={1.6} aria-hidden />
            </RichTextEditor.Control>
          </RichTextEditor.ControlsGroup>
        </RichTextEditor.Toolbar>
        <RichTextEditor.Content />
      </RichTextEditor>
      {error ? (
        <Text size="xs" c="red.8" role="alert">
          {error}
        </Text>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => void onImage(e.currentTarget.files?.[0])}
      />
      <Modal opened={mathOpen} onClose={() => setMathOpen(false)} title="Equation" size="lg">
        <Stack>
          <Textarea
            label="Type the equation as LaTeX"
            description="For example \frac{a}{b}, x^{2}, \sqrt{9}, H_{2}SO_{4}"
            value={latex}
            onChange={(e) => setLatex(e.currentTarget.value)}
            autosize
            minRows={2}
            data-autofocus
          />
          <Text size="sm" c="dimmed">
            Preview
          </Text>
          <div
            className="math-preview"
            aria-live="polite"
            dangerouslySetInnerHTML={{ __html: preview }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setMathOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveMath} disabled={!latex.trim()}>
              Insert equation
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
