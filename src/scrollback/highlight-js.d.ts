// `exports` 有 `./lib/core`，类型包只声明了 `lib/languages/*`。
declare module 'highlight.js/lib/core' {
  import hljs from 'highlight.js'
  export default hljs
}
