# Mote

Mote 是一个简单的个人笔记本和博客。

![screenshot](./samples/screenshot.png)

## 功能

* 分享笔记以作为博客
* 支持 MarkDown 语法，hashtag，图集
* 自动创建的标签，多层级标签
* 全文检索
* 移动端友好
* 暗黑主题
* 极简依赖

## Development

### 前端

前端使用了 React，进入 [frontend](./frontend) 查看详情。

### 后端

包含四种语言实现的后端服务，它们提供相同的功能，可任选一种进行开发。
切换至对应的目录查看详情：

* [api-go](./api-go)：Go + net/http

* [api-rs](./api-rs)：Rust + Axum

* [api-kt](./api-kt)：Kotlin + SpringBoot

* [api-py](./api-py)：Python + Flask

## 部署

本项目提供了一个部署示例，它使用 Rust 和 Axum 作为后端服务，并提供了 HTTPS 等生产级别的配置，进入 [deploy](./deploy) 查看详情。

## 技术选择

* 为什么是 SQLite

  [SQLite不是玩具数据库](https://antonz.org/sqlite-is-not-a-toy-database/)

  对于类似本项目的应用，它是一个接近完美的选择：零配置、极低的内存和 CPU 占用和不俗的性能。

* 全文检索 without ElasticSearch

  我使用了很便宜的云服务器（99￥/年）来部署本项目，ES 太吃内存，在这样服务器上很难运行起来。

  简单的倒排索引 + 朴素的 TF-IDF + Redis 对本项目够用了：[search_service.rs](./api-rs/src/service/search_service.rs)。

* 为什么不用 Next.js

  本项目基本不需要 SSR，博客页面用了 good old Jinja，朴实无华没有黑魔法。

  Next.js 为 React 又多加了层心智负担，“这个组件应该是 Server Component 吗”，“我要使用 server action 吗”，“数据怎么被缓存了”，“状态管理用那种方案”...

  当然，Next.js 作为 React 框架的“事实标准”，在很多时候我还是会很开心地使用它。

* 四种不同的后端 API

  最开始的后端服务使用的是 Python，有一天因为一个简单的手误导致一个很难定位的 bug，解决后就决定用 Kotlin 来重写。

  实际上主要是由 Claude 3.5 Sonnet 写的，开发体验极佳，唯一的小问题就是运行时内存比较高，我的云服务器上还有其他服务。

  然后又用 Rust 重写，内存占用约为之前的 1/5。
  
  最后又用 Go 重写，90% 代码由 Claude 4.5 Sonnet 编写。

* 基于 Slate 的富文本编辑器

  沉没成本较高，我已经基于 [Slate](https://github.com/ianstormtaylor/slate) 写了 [约 3,000 行代码](frontend/src/components/editor)，它不完美，简洁优雅的 API 下是简陋的插件机制、莫名其妙的 Bug、欠佳的性能和升级的战战兢兢。

  如果以后要重构，我可能会选择 [Tiptap](https://github.com/ueberdosis/tiptap) 与 [Lexical](https://github.com/facebook/lexical)。

## 致谢

界面受到了卡片笔记 [flomo](https://flomoapp.com/) 的启发，它提供了多种客户端，且功能更多。

## License

MIT
