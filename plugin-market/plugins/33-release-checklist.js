/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：33 | 分组：协作 · 评审与复盘
 * id: release-checklist | 命令: collab.releaseChecklist
 * 说明：插入发布前逐项确认清单。
 * 模式：append
 */
function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function appendBlock(md, block) {
  const text = String(md || '');
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const body = block.split('\n').join(eol) + eol;
  if (!text) return body;
  const sep = /\r?\n$/.test(text) ? eol : eol + eol;
  return text + sep + body;
}

export default {
  id: 'release-checklist',
  name: '发布检查清单',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.releaseChecklist',
      title: '插入发布前逐项确认清单',
      run() {
        const md = api.getMarkdown() || '';
        const block = [
          '## 🚀 发布检查清单 · ' + todayIso(),
          '',
          '### 构建产物',
          '- [ ] 版本号已更新且三端一致',
          '- [ ] 构建无告警，产物体积正常',
          '- [ ] 产物指纹已记录',
          '',
          '### 变更与文档',
          '- [ ] CHANGELOG 已补充本次条目',
          '- [ ] 发布说明已同步到公告渠道',
          '- [ ] 相关文档已更新',
          '',
          '### 备份与回滚',
          '- [ ] 数据库已备份并验证可恢复',
          '- [ ] 上一版本产物可回退',
          '- [ ] 回滚步骤已确认到人',
          '',
          '### 灰度与验证',
          '- [ ] 灰度范围已确定',
          '- [ ] 关键路径冒烟通过',
          '- [ ] 监控与告警已开启',
          '',
          '### 发布后',
          '- [ ] 观察 30 分钟错误率与延迟',
          '- [ ] 确认无用户侧异常反馈',
          '- [ ] 记录发布结论',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入发布检查清单（5 个环节）', 'success');
      }
    });
  }
};
