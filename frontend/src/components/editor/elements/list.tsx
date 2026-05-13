import { Editor, Element, Node, NodeEntry, Path, Point, Range, Transforms } from 'slate'
import { RenderElementProps } from 'slate-react'

import {
  BulletedListElement,
  CHECK_LIST,
  CODE_BLOCK,
  HEADINGS,
  LIST_ITEM,
  ListType,
  NumberedListElement,
  PARAGRAPH,
  isList,
} from '../types'
import {
  findElement,
  findElements,
  isEmptyLine,
  isFirstNode,
  isLastNode,
  liftNodeAndUnWrap,
} from '../utils'

export function withList(editor: Editor) {
  const { deleteBackward, normalizeNode, insertBreak } = editor

  // When pressing `delete` at the start of a list-item,
  // either move it to the parent node or merge it with the previous list-item
  editor.deleteBackward = (...args) => {
    const { selection } = editor
    if (selection && Range.isCollapsed(selection)) {
      const itemEntry = findElement(editor, LIST_ITEM)

      if (itemEntry) {
        const [, itemPath] = itemEntry
        const start = Editor.start(editor, itemPath)

        if (Point.equals(selection.anchor, start)) {
          if (isFirstNode(editor, itemPath)) {
            // If it is the first list-item, move it to the parent node
            // For example, for the list-item containing "b"
            // from ---------------> to
            /*
              ul                       ul
                li                       li
                  p[text="a"]              p[text="a"]
                  ul                       p[text="b"]
                    li                     ul
                      p[text="b"]            li
                    li                         p[text="c"]
                      p[text="c"]
             */
            liftNodeAndUnWrap(editor, itemPath)
          } else {
            // If it is not the first list-item, merge it with the previous list-item
            // For example, for the list-item containing "b":
            /*
              ul                       ul
                li                       li
                  p[text="a"]              p[text="a"]
                li                         p[text="b"]
                  p[text="b"]
             */
            Transforms.mergeNodes(editor, {
              at: itemPath,
            })
          }
          return
        }
      }
    }

    deleteBackward(...args)
  }

  // When pressing `enter` in a list-item, either deindent one level or split the node
  editor.insertBreak = () => {
    const { selection } = editor
    if (selection && Range.isCollapsed(selection)) {
      const itemEntry = findElement(editor, LIST_ITEM)
      if (itemEntry) {
        if (isEmptyLine(editor, itemEntry[1]) && isLastNode(editor, itemEntry[1])) {
          // If the cursor is in the last item of a list, and the item is an empty line,
          // deindent one level seems more reasonable
          deIndentList(editor)
        } else {
          // NOTE: The priority of this `insertBreak` should be relatively low
          // to avoid affecting the behavior of `insertBreak` in code-blocks and block-quotes
          Transforms.splitNodes(editor, {
            match: (node) => Element.isElement(node) && node.type === LIST_ITEM,
            mode: 'lowest',
            // If `true`, split at the beginning and end of the line as well
            always: true,
          })
        }
        return
      }
    }

    insertBreak()
  }

  editor.normalizeNode = (entry) => {
    const [node, path] = entry

    // If the child of ul/ol is not a list-item, wrap it with a list-item
    // NOTE: This situation seems unlikely to occur; this normalization might be redundant
    if (Element.isElement(node) && isList(node.type)) {
      for (const [childNode, childPath] of Node.children(editor, path)) {
        if ((childNode as { type?: string }).type !== LIST_ITEM) {
          Transforms.wrapNodes(
            editor,
            {
              type: LIST_ITEM,
              children: [],
            },
            {
              at: childPath,
            },
          )
        }
      }

      // Merge adjacent ol or ul nodes to improve user experience
      const prevNodeEntry = Editor.previous(editor, { at: path })
      if (prevNodeEntry) {
        if ((prevNodeEntry[0] as Element).type === node.type) {
          Transforms.mergeNodes(editor, {
            at: path,
          })
        }
      }

      return
    }

    normalizeNode(entry)
  }

  return editor
}

export function indentList(editor: Editor) {
  const { selection } = editor
  if (selection == null) {
    return
  }

  // Operations on multiple list-items are not supported
  if (!Range.isCollapsed(selection)) {
    return
  }
  const itemEntry = findElement(editor, LIST_ITEM)

  // If no list currently exists
  if (!itemEntry) {
    return
  }

  const [, itemPath] = itemEntry

  // listNode must be ul/ol
  const [listNode] = Editor.parent(editor, itemPath)

  const prevItemEntry = Editor.previous(editor, { at: itemPath })
  // If the current node is the first list-item, it cannot be indented further,
  // because the indentation level increases sequentially
  if (!prevItemEntry) {
    return
  }

  Editor.withoutNormalizing(editor, () => {
    // For example, to indent the list-item containing "b":
    /*
      ul
        li
          p[text="a"]
        li
          p[text="b"]
     */

    const itemPathRef = Editor.pathRef(editor, itemPath)

    // 1. Wrap the current list-item with ul/ol
    // NOTE: The temporarily generated node might be *invalid*
    /*
      ul
        li
          p[text="a"]
        ul
          li
            p[text="b"]
     */

    Transforms.wrapNodes(
      editor,
      {
        type: (listNode as Element).type,
        children: [],
      },
      { at: itemPath },
    )

    // 2. Find the path of the last child of the previous list-item
    const [[, lastChildPathOfPrevItemNode]] = Node.children(editor, prevItemEntry[1], {
      reverse: true,
    })

    // 3. Move the temporarily generated ul/ol to the end of the previous list-item
    /*
      ul
        li
          p[text="a"]
          ul
            li
              p[text="b"]
     */
    Transforms.moveNodes(editor, {
      at: Path.parent(itemPathRef.current!),
      to: Path.next(lastChildPathOfPrevItemNode),
    })

    itemPathRef.unref()
  })
}

export function deIndentList(editor: Editor) {
  const { selection } = editor
  if (selection == null) {
    return
  }

  if (!Range.isCollapsed(selection)) {
    return
  }

  const itemEntry = findElement(editor, LIST_ITEM)

  if (!itemEntry) {
    return
  }

  const [, itemPath] = itemEntry

  // The parent node is ul/ol
  const [parentNode, parentPath] = Editor.parent(editor, itemPath)

  // If the list-item is in a multi-level list, its parent's parent is a list-item
  /*
    li
      p[text="a"]
      ul
        li
          p[text="b"]
        li
          p[text="c"]
   */
  const [grandpaNode, grandpaPath] = Editor.parent(editor, parentPath)

  // If the list-item is not in a multi-level list, lift and unwrap directly
  // For example, for the list-item containing "b":
  /*
    ul                          ul
      li                          li
        p[text="a"]                 p[text="a"]
      li                        p[text="b"]
        p[text="b"]             ul
      li                          li
        p[text="c"]                 p[text="c"]
   */
  if ((grandpaNode as Element).type !== LIST_ITEM) {
    liftNodeAndUnWrap(editor, itemPath)
    return
  }

  Editor.withoutNormalizing(editor, () => {
    const nextItemEntry = Editor.next(editor, { at: itemPath })

    // If the current node is the last list-item, move it to the upper level
    // For example, for the list-item containing "c":
    /*
      ul                        ul
        li                        li
          p[text="a"]               p[text="a"]
          ul                        ul
            li                        li
              p[text="b"]               p[text="b"]
            li                    li
              p[text="c"]           p[text="c"]
     */
    if (!nextItemEntry) {
      const childNum = parentNode.children.length
      Transforms.moveNodes(editor, {
        at: itemPath,
        to: Path.next(grandpaPath),
      })

      // NOTE: If the current node is the only child, moving it will result in an ul/ol with `[]` as children,
      // in which case the ul/ol must be deleted, otherwise Slate will throw an error:
      // "Cannot get the start point in the node at path [xxx], because it has no start text node."
      if (childNum === 1) {
        Transforms.removeNodes(editor, {
          at: parentPath,
        })
      }
    } else {
      // If the current node is not the last list-item
      // For example, for the list-item containing "b":
      /*
        ul
          li
            p[text="a"]
            ul
              li
                p[text="b"]
              li
                p[text="c"]
       */
      const itemIsFirstChild = isFirstNode(editor, itemPath)

      const [[, lastItemPath]] = Node.children(editor, parentPath, {
        reverse: true,
      })
      const startPointOfNextItem = Editor.start(editor, nextItemEntry[1])
      const endPoint = Editor.end(editor, lastItemPath)

      // 1. Wrap all list-items after this list-item under the same parent with ul/ol
      // NOTE: The temporarily generated node might be *invalid*
      /*
        ul
          li
            p[text="a"]
            ul
              li
                p[text="b"]
              ul
                li
                  p[text="c"]
       */
      Transforms.wrapNodes(
        editor,
        { type: (parentNode as Element).type, children: [] },
        {
          at: { anchor: startPointOfNextItem, focus: endPoint },
          match: (node, path) =>
            Element.isElement(node) && node.type === LIST_ITEM && path.length === itemPath.length,
        },
      )

      // Find the path of the temporarily generated ul/ol
      const [[, lastChildPath]] = Node.children(editor, itemPath, {
        reverse: true,
      })

      // 2. Move the temporarily generated ul/ol to the end of the list-item to be de-indented
      // WTF: This operation will cause the cursor to jump to the beginning of the generated indented sublist...
      /*
        ul
          li
            p[text="a"]
            ul
              li
                p[text="b"]
                ul
                  li
                    p[text="c"]
       */

      Transforms.moveNodes(editor, {
        at: Path.next(itemPath),
        to: Path.next(lastChildPath),
      })

      // 3. Move this list-item to the outermost level, i.e., under the grandparent ul/ol
      /*
        ul
          li
            p[text="a"]
            ul
          li
            p[text="b"]
            ul
              li
                p[text="c"]
       */
      Transforms.moveNodes(editor, {
        at: itemPath,
        to: Path.next(grandpaPath),
      })

      // 4. If the current node is the first list-item, moving it will result in an ul/ol with `[]` as children,
      // in which case the ul/ol must be deleted, otherwise Slate will throw an error:
      if (itemIsFirstChild) {
        Transforms.removeNodes(editor, {
          at: parentPath,
        })
      }
    }
  })
}

// Only check if the lowest-level `listType` is active
export function isListActive(editor: Editor, listType: ListType) {
  const nodeEntry = findListNode(editor)
  if (!nodeEntry) {
    return false
  }
  return nodeEntry[0].type === listType
}

export function toggleList(editor: Editor, newType: ListType) {
  // NOTE: Even if multiple ul/ol are selected, only the first one is considered
  const nodeEntry = findListNode(editor)

  if (!nodeEntry) {
    wrapList(editor, newType)
    return
  }

  const [listNode, listPath] = nodeEntry

  if (listNode.type === newType) {
    unwrapList(editor, listPath)
  } else {
    Transforms.setNodes(
      editor,
      { type: newType },
      {
        at: listPath,
      },
    )
  }
}

export function ListItem({ attributes, children }: RenderElementProps) {
  return <li {...attributes}>{children}</li>
}

export function BulletedList({ attributes, children }: RenderElementProps) {
  return <ul {...attributes}>{children}</ul>
}

export function NumberedList({ attributes, children, element }: RenderElementProps) {
  return (
    <ol {...attributes} start={(element as NumberedListElement).start}>
      {children}
    </ol>
  )
}

// NOTE: All non-list block nodes can be wrapped
export function wrapList(editor: Editor, type: string) {
  const nodes = Array.from(findElements(editor, [...HEADINGS, PARAGRAPH, CODE_BLOCK, CHECK_LIST]))
  if (nodes.length === 0) {
    return
  }

  // Ensure all nodes have consistent levels
  const parentPath = Path.parent(nodes[0][1])
  const sameLevel = nodes
    .map((node) => Path.parent(node[1]))
    .every((value) => Path.equals(value, parentPath))

  if (!sameLevel) {
    return
  }

  Editor.withoutNormalizing(editor, () => {
    for (const [, path] of nodes) {
      // Wrap all nodes with a list-item
      Transforms.wrapNodes(
        editor,
        {
          type: LIST_ITEM,
          children: [],
        },
        {
          at: path,
        },
      )
    }

    // Wrap the generated list-item with ul/ol
    Transforms.wrapNodes(
      editor,
      {
        type,
        children: [],
      },
      {
        match: (node) => Element.isElement(node) && node.type === LIST_ITEM,
        mode: 'lowest',
      },
    )
  })
}

function unwrapList(editor: Editor, listPath: Path) {
  Editor.withoutNormalizing(editor, () => {
    const childPaths = Array.from(Node.children(editor, listPath)).map((item) => item[1])
    const pathRefs = childPaths.map((item) => Editor.pathRef(editor, item))

    for (const pathRef of pathRefs) {
      // Unwrap all list-items under ul/ol
      Transforms.unwrapNodes(editor, {
        at: pathRef.current!,
      })
    }

    // Finally, unwrap the ul/ol
    Transforms.unwrapNodes(editor, {
      at: listPath,
    })

    pathRefs.forEach((item) => item.unref())
  })
}

// NOTE: For simplicity, only find the lowest *one* ul/ol
function findListNode(editor: Editor) {
  const { selection } = editor
  if (!selection) {
    return null
  }

  const itemEntry = findElement(editor, LIST_ITEM)

  // If no list currently exists
  if (!itemEntry) {
    return null
  }

  // The parent of listNode is ul/ol
  return Editor.parent(editor, itemEntry[1]) as NodeEntry<NumberedListElement | BulletedListElement>
}
