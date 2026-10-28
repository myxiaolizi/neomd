/* Neo MD UI 组件库。
 * 主题变量（themes.css）在此处引入，保证任何用到 @neomd/ui 的宿主
 * 都能拿到 data-theme-preset 对应的整套变量；styles/index.css 里也有
 * 一份 @import，是为「只引样式不引组件」的场景兜底（Vite 会去重）。 */
import './styles/themes.css';

export { default as NmIcon } from './components/Icon.vue';
export { default as NmModal } from './components/Modal.vue';
export { default as NmToggle } from './components/Toggle.vue';
export { default as NmSelect } from './components/Select.vue';
