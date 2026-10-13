# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: check-preview.mjs >> incomplete question reference fallbacks close after reverting text and keep real edits
- Location: scripts/check-preview.mjs:223:1

# Error details

```
TimeoutError: locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /Incomplete choice reference$/ }).locator('..').getByRole('button', { name: '编辑题目', exact: true })

```

# Page snapshot

```yaml
- generic [ref=f1e2]:
  - generic [ref=f1e3]:
    - complementary [ref=f1e4]:
      - generic [ref=f1e5]:
        - button "收起侧边栏" [expanded] [ref=f1e6]
        - generic [ref=f1e8]: PractiQ
      - navigation "主导航" [ref=f1e10]:
        - button "我的题库" [ref=f1e11]
        - button "错题本" [ref=f1e13]
        - button "收藏夹" [ref=f1e15]
        - button "练习记录" [ref=f1e17]
      - generic [ref=f1e19]:
        - button "主题" [ref=f1e21]
        - button "语言" [ref=f1e24]
        - button "设置" [ref=f1e26]
    - main [ref=f1e28]:
      - generic [ref=f1e29]:
        - generic [ref=f1e31]:
          - heading "我的题库" [level=1] [ref=f1e32]
          - paragraph [ref=f1e33]: 4 个题库 · 30 道题目
        - generic [ref=f1e34]:
          - button "新建题库" [ref=f1e35]
          - button "导入" [ref=f1e36]
          - button "合并题库" [ref=f1e37]
      - generic [ref=f1e40]:
        - generic [ref=f1e42]:
          - generic [ref=f1e43]:
            - heading "继续未完成的练习" [level=2] [ref=f1e44]
            - paragraph [ref=f1e45]: 每日练习 · 未完成 · 已提交 0/9 题
          - generic [ref=f1e46]:
            - button "查看全部" [ref=f1e47]
            - button "继续练习" [ref=f1e48]
        - generic [ref=f1e49]:
          - generic [ref=f1e50]:
            - generic [ref=f1e51]:
              - generic [ref=f1e52]:
                - heading "基础知识 · 全题型" [level=2] [ref=f1e54]
                - generic [ref=f1e55]:
                  - generic [ref=f1e56]: 9 题
                  - button "题库操作 基础知识 · 全题型" [ref=f1e57]
              - generic [ref=f1e58]: 开发预览样例，可编辑、收藏和练习；重置后恢复。
            - generic [ref=f1e59]:
              - button "查看题目" [ref=f1e60]
              - button "开始练习" [ref=f1e61]
          - generic [ref=f1e62]:
            - generic [ref=f1e63]:
              - generic [ref=f1e64]:
                - heading "英语专项 · 听力与写作" [level=2] [ref=f1e66]
                - generic [ref=f1e67]:
                  - generic [ref=f1e68]: 11 题
                  - button "题库操作 英语专项 · 听力与写作" [ref=f1e69]
              - generic [ref=f1e70]: 开发预览样例，可编辑、收藏和练习；重置后恢复。
            - generic [ref=f1e71]:
              - button "查看题目" [ref=f1e72]
              - button "开始练习" [ref=f1e73]
          - generic [ref=f1e74]:
            - generic [ref=f1e75]:
              - generic [ref=f1e76]:
                - heading "阅读与组合题" [level=2] [ref=f1e78]
                - generic [ref=f1e79]:
                  - generic [ref=f1e80]: 10 题
                  - button "题库操作 阅读与组合题" [ref=f1e81]
              - generic [ref=f1e82]: 开发预览样例，可编辑、收藏和练习；重置后恢复。
            - generic [ref=f1e83]:
              - button "查看题目" [ref=f1e84]
              - button "开始练习" [ref=f1e85]
          - generic [ref=f1e86]:
            - generic [ref=f1e87]:
              - generic [ref=f1e88]:
                - heading "新建空题库" [level=2] [ref=f1e90]
                - generic [ref=f1e91]:
                  - generic [ref=f1e92]: 0 题
                  - button "题库操作 新建空题库" [ref=f1e93]
              - generic [ref=f1e94]: 用于预览空题库与新增题目。
            - button "查看题目" [ref=f1e96]
        - button "刷新" [ref=f1e98]
    - region "通知 alt+T"
  - group [ref=f1e99]:
    - generic "开发预览 · 示例数据" [ref=f1e100] [cursor=pointer]
    - option "完整数据" [selected]
    - option "空数据"
    - option "多页数据"
    - option "慢加载"
    - option "请求失败"
    - option "未配置 AI 服务"
    - option "资源缺失"
    - option "真实本地数据"
```

# Test source

```ts
  138 |   await expect(editor).toBeHidden();
  139 |   await expect(page.getByRole('alertdialog')).toHaveCount(0);
  140 |  });
  141 | }
  142 | 
  143 | test('new question reverted nullable fields close without discarding other edits',async ({page})=>{
  144 |  await page.goto('/');
  145 |  await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
  146 |  const editor=page.getByRole('dialog',{name:'编辑题目',exact:true});
  147 |  const instructions=editor.getByRole('textbox',{name:'作答说明',exact:true});
  148 |  const open=()=>page.getByRole('button',{name:'新增题目',exact:true}).click();
  149 |  for(const action of ['Escape','close','outside']){
  150 |   await open();
  151 |   await instructions.fill('Temporary instructions');
  152 |   await instructions.fill('');
  153 |   if(action==='Escape')await page.keyboard.press('Escape');
  154 |   else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  155 |   else await page.mouse.click(8,8);
  156 |   await expect(editor).toBeHidden();
  157 |   await expect(page.getByRole('alertdialog')).toHaveCount(0);
  158 |  }
  159 |  await open();
  160 |  await instructions.fill('Temporary instructions');
  161 |  await instructions.fill('');
  162 |  const stem=editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true});
  163 |  await stem.fill('Actual changed stem');
  164 |  await page.keyboard.press('Escape');
  165 |  const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  166 |  await expect(confirmation).toBeVisible();
  167 |  await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  168 |  await expect(stem).toHaveValue('Actual changed stem');
  169 |  await expect(stem).toBeFocused();
  170 |  await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
  171 |  await expect(editor).toBeHidden();
  172 | });
  173 | 
  174 | test('reverted empty reference answers close without losing real editor changes',async ({page})=>{
  175 |  await page.goto('/');
  176 |  await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
  177 |  const editor=page.getByRole('dialog',{name:'编辑题目',exact:true});
  178 |  const open=()=>page.getByRole('button',{name:'新增题目',exact:true}).click();
  179 |  for(const mode of ['short_answer','choice','fill_blank']){
  180 |   for(const action of ['Escape','close','outside']){
  181 |    await open();
  182 |    if(mode!=='choice')await editor.getByLabel('答题方式',{exact:true}).selectOption(mode);
  183 |    else {
  184 |     await editor.getByLabel('选择题类型',{exact:true}).selectOption('multiple');
  185 |     await editor.getByRole('textbox',{name:'选项 1 内容',exact:true}).fill('One');
  186 |     await editor.getByRole('textbox',{name:'选项 2 内容',exact:true}).fill('Two');
  187 |    }
  188 |    // Save the mode first so the reopened reference starts null with no other draft.
  189 |    await editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true}).fill(`Empty reference ${mode} ${action}`);
  190 |    await editor.getByRole('button',{name:'保存题目',exact:true}).click();
  191 |    const row=page.getByRole('button',{name:new RegExp(`Empty reference ${mode} ${action}$`)}).locator('..');
  192 |    await row.getByRole('button',{name:'编辑题目',exact:true}).click();
  193 |    if(mode==='choice'){
  194 |     const choice=editor.getByRole('checkbox',{name:/A\./});
  195 |     await choice.check();await choice.uncheck();
  196 |    }else{
  197 |     const text=editor.getByRole('textbox',{name:mode==='short_answer'?'作答内容':'第 1 空',exact:true});
  198 |     await text.fill('Temporary reference');await text.fill('');
  199 |    }
  200 |    if(action==='Escape')await page.keyboard.press('Escape');
  201 |    else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  202 |    else await page.mouse.click(8,8);
  203 |    await expect(editor).toBeHidden();
  204 |    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  205 |   }
  206 |  }
  207 |  const changedRow=page.getByRole('button',{name:/Empty reference fill_blank outside$/}).locator('..');
  208 |  await changedRow.getByRole('button',{name:'编辑题目',exact:true}).click();
  209 |  const answer=editor.getByRole('textbox',{name:'第 1 空',exact:true});
  210 |  await answer.fill('Real reference');
  211 |  await page.keyboard.press('Escape');
  212 |  const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  213 |  await expect(confirmation).toBeVisible();
  214 |  await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  215 |  await expect(answer).toHaveValue('Real reference');
  216 |  await editor.getByRole('button',{name:'保存题目',exact:true}).click();
  217 |  await changedRow.getByRole('button',{name:'编辑题目',exact:true}).click();
  218 |  await expect(answer).toHaveValue('Real reference');
  219 |  await page.keyboard.press('Escape');
  220 |  await expect(editor).toBeHidden();
  221 | });
  222 | 
  223 | test('incomplete question reference fallbacks close after reverting text and keep real edits',async ({page})=>{
  224 |  await page.goto('/');
  225 |  await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
  226 |  const editor=page.getByRole('dialog',{name:'编辑题目',exact:true});
  227 |  for(const mode of ['choice','ordering','matching']){
  228 |   await page.getByRole('button',{name:'新增题目',exact:true}).click();
  229 |   if(mode!=='choice')await editor.getByRole('combobox',{name:'答题方式',exact:true}).selectOption(mode);
  230 |   const title=`Incomplete ${mode} reference`;
  231 |   await editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true}).fill(title);
  232 |   await editor.getByRole('button',{name:'保存题目',exact:true}).click();
  233 |   const open=async()=>{
  234 |    const button=page.getByRole('button',{name:new RegExp(`${title}$`)}).locator('..').getByRole('button',{name:'编辑题目',exact:true});
  235 |    await button.evaluate(node=>node.scrollIntoView({block:'center'}));
  236 |    await page.mouse.move(0,0);
  237 |    await expect(page.getByText('题目已保存，历史练习不受影响',{exact:true})).toBeHidden();
> 238 |    await button.click();
      |                 ^ TimeoutError: locator.click: Timeout 10000ms exceeded.
  239 |   };
  240 |   for(const dismiss of ['Escape','close','outside']){
  241 |    await open();
  242 |    const text=editor.getByRole('textbox',{name:'自由作答',exact:true});
  243 |    await text.fill('Temporary reference');await text.fill('');
  244 |    if(dismiss==='Escape')await page.keyboard.press('Escape');
  245 |    else if(dismiss==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  246 |    else await page.mouse.click(8,8);
  247 |    await expect(editor).toBeHidden();
  248 |    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  249 |   }
  250 |   await open();
  251 |   const text=editor.getByRole('textbox',{name:'自由作答',exact:true});
  252 |   await text.fill('Actual reference');
  253 |   await page.keyboard.press('Escape');
  254 |   const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  255 |   await expect(confirmation).toBeVisible();
  256 |   await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  257 |   await expect(text).toHaveValue('Actual reference');
  258 |   await editor.getByRole('button',{name:'保存题目',exact:true}).click();
  259 |   await open();
  260 |   await expect(text).toHaveValue('Actual reference');
  261 |   await text.fill('');
  262 |   await page.keyboard.press('Escape');
  263 |   await expect(confirmation).toBeVisible();
  264 |   await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  265 |   await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
  266 |  }
  267 | });
  268 | 
  269 | test('listening URL drafts survive every implicit dismissal without triggering downloads',async ({page})=>{
  270 |  const remoteRequests=[];
  271 |  page.on('request',request=>{if(request.url().startsWith('https://example.com/'))remoteRequests.push(request.url());});
  272 |  await page.goto('/');
  273 |  const bank=page.locator('[data-slot=card]').filter({has:page.getByText('英语专项 · 听力与写作',{exact:true})});
  274 |  await bank.getByRole('button',{name:'查看题目',exact:true}).click();
  275 |  const open=()=>page.getByRole('button',{name:/Listening — chimes$/}).locator('..').getByRole('button',{name:'编辑题目',exact:true}).click();
  276 |  const editor=page.getByRole('dialog',{name:'编辑题目',exact:true});
  277 |  const input=editor.getByRole('textbox',{name:'听力资源网址',exact:true});
  278 |  await open();
  279 |  const url='https://example.com/unapplied.wav';
  280 |  await input.fill(url);
  281 |  await expect(editor.getByRole('button',{name:'保存题目',exact:true})).toBeDisabled();
  282 |  await expect(editor.getByRole('status').filter({hasText:'网址尚未应用'})).toBeVisible();
  283 |  for(const action of ['Escape','close','outside']){
  284 |   await input.focus();
  285 |   if(action==='Escape')await page.keyboard.press('Escape');
  286 |   else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  287 |   else await page.mouse.click(8,8);
  288 |   const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  289 |   await expect(confirmation).toBeVisible();
  290 |   await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  291 |   await expect(confirmation).toBeHidden();
  292 |   await expect(input).toHaveValue(url);
  293 |   await expect(action==='close'?editor.getByRole('button',{name:'关闭',exact:true}):input).toBeFocused();
  294 |  }
  295 |  await input.fill('');
  296 |  await expect(editor.getByRole('button',{name:'保存题目',exact:true})).toBeEnabled();
  297 |  await page.keyboard.press('Escape');
  298 |  await expect(editor).toBeHidden();
  299 |  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  300 |  await open();
  301 |  await editor.getByRole('button',{name:'识别二维码图片',exact:true}).click();
  302 |  await expect(input).toHaveValue('https://example.com/listening.mp3');
  303 |  await page.keyboard.press('Escape');
  304 |  const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  305 |  await expect(confirmation).toBeVisible();
  306 |  await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  307 |  await expect(input).toHaveValue('https://example.com/listening.mp3');
  308 |  await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
  309 |  await expect(editor).toBeHidden();
  310 |  expect(remoteRequests).toEqual([]);
  311 | });
  312 | 
  313 | test('applied listening URLs become guarded when their audio is removed or replaced',async ({page})=>{
  314 |  const remoteRequests=[];
  315 |  page.on('request',request=>{if(request.url().startsWith('https://example.com/'))remoteRequests.push(request.url());});
  316 |  await page.goto('/');
  317 |  const bank=page.locator('[data-slot=card]').filter({has:page.getByText('英语专项 · 听力与写作',{exact:true})});
  318 |  await bank.getByRole('button',{name:'查看题目',exact:true}).click();
  319 |  const editor=page.getByRole('dialog',{name:'编辑题目',exact:true});
  320 |  const input=editor.getByRole('textbox',{name:'听力资源网址',exact:true});
  321 |  const save=editor.getByRole('button',{name:'保存题目',exact:true});
  322 |  const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  323 |  for(const action of ['remove','mode','file']){
  324 |   await page.getByRole('button',{name:/Listening — chimes$/}).locator('..').getByRole('button',{name:'编辑题目',exact:true}).click();
  325 |   const url=`https://example.com/${action}.wav`;
  326 |   await input.fill(url);
  327 |   await editor.getByRole('button',{name:'从网址获取音频',exact:true}).click();
  328 |   await expect(save).toBeEnabled();
  329 |   if(action==='remove')await editor.getByRole('button',{name:'移除音频',exact:true}).click();
  330 |   else if(action==='mode'){
  331 |    await editor.getByRole('combobox',{name:'答题方式',exact:true}).selectOption('short_answer');
  332 |    await editor.getByRole('combobox',{name:'答题方式',exact:true}).selectOption('listening');
  333 |   }else await editor.getByRole('button',{name:'选择听力音频',exact:true}).click();
  334 |   await expect(save).toBeDisabled();
  335 |   await expect(input).toHaveValue(url);
  336 |   await expect(editor.getByRole('status').filter({hasText:'网址尚未应用'})).toBeVisible();
  337 |   for(const dismiss of ['Escape','close','outside']){
  338 |    await input.focus();
```