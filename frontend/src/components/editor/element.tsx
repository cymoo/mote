import { RenderElementProps } from 'slate-react'

import { BlockQuote } from './elements/block-quote'
import { CheckList } from './elements/check-list'
import { CodeBlock } from './elements/code-block'
import { HashTag } from './elements/hash-tag'
import { HeadingFive, HeadingFour, HeadingOne, HeadingThree, HeadingTwo } from './elements/heading'
import { Image } from './elements/image'
import { Link } from './elements/link'
import { BulletedList, ListItem, NumberedList } from './elements/list'
import { Paragraph } from './elements/paragraph'
import { Table, TableCell, TableRow } from './elements/table'
import {
  BLOCK_QUOTE,
  BULLETED_LIST,
  CHECK_LIST,
  CODE_BLOCK,
  HASH_TAG,
  HEADING_FIVE,
  HEADING_FOUR,
  HEADING_ONE,
  HEADING_THREE,
  HEADING_TWO,
  IMAGE,
  LINK,
  LIST_ITEM,
  NUMBERED_LIST,
  TABLE,
  TABLE_CELL,
  TABLE_ROW,
} from './types'

export const Element = (props: RenderElementProps) => {
  const { element } = props

  switch (element.type) {
    case LINK:
      return <Link {...props} />
    case IMAGE:
      return <Image {...props} />
    case HASH_TAG:
      return <HashTag {...props} />
    case BULLETED_LIST:
      return <BulletedList {...props} />
    case NUMBERED_LIST:
      return <NumberedList {...props} />
    case LIST_ITEM:
      return <ListItem {...props} />
    case CHECK_LIST:
      return <CheckList {...props} />
    case HEADING_ONE:
      return <HeadingOne {...props} />
    case HEADING_TWO:
      return <HeadingTwo {...props} />
    case HEADING_THREE:
      return <HeadingThree {...props} />
    case HEADING_FOUR:
      return <HeadingFour {...props} />
    case HEADING_FIVE:
      return <HeadingFive {...props} />
    case CODE_BLOCK:
      return <CodeBlock {...props} />
    case BLOCK_QUOTE:
      return <BlockQuote {...props} />
    case TABLE:
      return <Table {...props} />
    case TABLE_ROW:
      return <TableRow {...props} />
    case TABLE_CELL:
      return <TableCell {...props} />
    default:
      return <Paragraph {...props} />
  }
}
