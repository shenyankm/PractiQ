import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { ZipFile } from "yazl";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentBankImport } from "../src/contracts.generated.js";
import { setTimeout as delay } from "node:timers/promises";
import type { WebPreferences } from "electron";

assert.ok(process.argv.length === 2 || process.argv.length === 4 && process.argv[2] === "--installed", "Use --installed /absolute/path/to/PractiQ for installed acceptance");
const executable = process.argv[3] ? await realpath(process.argv[3]) : undefined;
const directory = await mkdtemp(join(tmpdir(), "practiq-electron-smoke-")), profile = join(directory, "chromium");
const practiceDirectory = executable ? join(profile, "v4") : join(directory, "v4");
let modelCalls = 0;
let documentModelCalls = 0;
const model = createServer(async (request, response) => {
  assert.equal(request.url, "/v1/responses"); assert.equal(request.headers.authorization, "Bearer TEST_ONLY_ENCRYPTED_KEY");
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.store, false);
  if (body.tools[0].name === "UnitParseResult") {
    documentModelCalls++;
    const text = body.input[1].content[0].text; assert.match(text, /Reparse fixture/);
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "UnitParseResult", arguments: JSON.stringify({ questions: [{ id: "fragment:1:1", stem: "Reparse fixture?", answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: "Supplied answer" }, sourceText: "1. Short answer: Reparse fixture?\nReference answer: Supplied answer", confidence: 1, needsReview: false }], groups: [] }) }], usage: { input_tokens: 10, output_tokens: 5 } })); return;
  }
  assert.equal(body.tools[0].name, "GradeResult");
  assert.match(body.input[1].content[0].text, /我的评分作答/); modelCalls++;
  response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "GradeResult", arguments: JSON.stringify({ scoreCents: 300, maxCents: 500, reason: modelCalls === 1 ? "评分引用验证通过" : "明确重新评分验证通过", evidence: [], reviewReasons: [], criteria: [{ criterion: "原题评分点", scoreCents: 300, maxCents: 500, referenceQuote: "固定评分依据", answerQuote: "我的评分作答", reason: "仅比较给定内容" }] }) }], usage: { input_tokens: 10, output_tokens: 5 } }));
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
model.unref();
const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !["ELECTRON_RUN_AS_NODE", "PRACTIQ_DEV_URL", "PRACTIQ_DATA_DIR"].includes(key))) as Record<string, string>;
if (executable) environment.PATH = "/usr/bin:/bin:/usr/sbin:/sbin"; else environment.PRACTIQ_DATA_DIR = practiceDirectory;
const instance = await electron.launch({
  timeout: 15_000,
  executablePath: executable, cwd: executable ? directory : undefined,
  args: [...(executable ? [] : [resolve(".build/electron/app/desktop/main.js")]), `--user-data-dir=${profile}`, "--lang=zh-CN"],
  env: environment,
});
let stage = "compiled runtime guards";
const receipt = `.build/evidence/electron-${executable ? "installed" : "runtime"}-smoke.json`;
const watchdog = setTimeout(() => {
  console.error(`Electron smoke timed out during ${stage}; full acceptance is incomplete`); const child = instance.process(); child.kill("SIGTERM");
  const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000); force.unref();
}, 120000); watchdog.unref();
try {
  instance.process().stderr?.on("data", data => process.stderr.write(data));
  const page = await instance.firstWindow({ timeout: 15_000 });
  const installation = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath("userData"), executable: process.execPath, node: process.versions.node, electron: process.versions.electron }));
  assert.equal(installation.packaged, Boolean(executable)); assert.equal(await realpath(installation.userData), await realpath(profile));
  if (executable) { assert.equal(await realpath(installation.executable), executable); assert.ok(!installation.appPath.startsWith(await realpath(process.cwd()) + "/"), "Installed smoke must run a copied app outside the checkout"); }
  const runtimeDirectory = executable ? join(installation.appPath, ".build/electron/app/desktop") : resolve(".build/electron/app/desktop");
  await mkdir(".build/evidence", { recursive: true }); await writeFile(receipt, JSON.stringify({ checkedAt: new Date().toISOString(), ...installation, stage, passed: false }, null, 2) + "\n");
  const unexpectedHttpApis: string[] = [];
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => console.error(error.message));
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  page.on("response", response => { const url = new URL(response.url()); if (url.pathname.startsWith("/api/")) unexpectedHttpApis.push(url.pathname); if (response.status() >= 400) console.error(`HTTP ${response.status()}: ${url.origin}${url.pathname}`); });
  await page.waitForFunction(() => typeof (window as unknown as { practiq?: { request?: unknown } }).practiq?.request === "function", undefined, { timeout: 15_000 });
  const security = await instance.evaluate(({ BrowserWindow }) => {
    const preferences = (BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): WebPreferences }).getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require), "undefined");
  const codecCases = JSON.parse(await readFile("fixtures/tencent/zip-codecs.json", "utf8")) as Record<string, string>;
  const textResults: string[] = [];
  for (const text of ["first\n", "second\n"]) { const zip = new ZipFile(); zip.addBuffer(Buffer.from(text), "source_md_full.md"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); textResults.push(Buffer.concat(chunks).toString("base64")); }
  const rasterZip = new ZipFile(); rasterZip.addBuffer(Buffer.from(JSON.stringify({ width: 100, height: 100, elements: [{ text_info: { content: "first" } }] })), "x_ocr_page0.json"); rasterZip.end(); const rasterChunks: Buffer[] = []; for await (const chunk of rasterZip.outputStream) rasterChunks.push(Buffer.from(chunk)); const rasterResult = Buffer.concat(rasterChunks).toString("base64"), rasterSources = await Promise.all(["pdf/unembedded-cjk.pdf", "images/gray16.png", "office/中文 试卷.docx", "office/中文 表格.xlsx", "office/hidden-slides.pptx", "office/hidden-slides.ppt"].map(async path => (await readFile(`fixtures/${path}`)).toString("base64")));
  const legacyPptExpected = JSON.parse(await readFile("fixtures/office/legacy-slides-parity.json", "utf8")).cases.find((value: { file: string }) => value.file === "hidden-slides.ppt").visibleSha256;
  const codecReport = await instance.evaluate(async (_electron, input) => {
    const { Worker } = process.getBuiltinModule("node:worker_threads"), worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.moduleUrl).then(async({TencentBundle,ocrSourceEvidence})=>{
        const results=[];
        for(const [method,encoded] of Object.entries(workerData.cases)){
          const bundle=await TencentBundle.open(Buffer.from(encoded,'base64'),{pageCount:1});
          try{const image=await bundle.image('image.png');results.push({method,bytes:image.bytes.length,mediaType:image.mediaType});}finally{bundle.close();}
        }
        const [{AiDatabase},{AiStorage,sourceKey},{SqliteCheckpoints},{SqliteStore},{DocumentTasks},{DocumentRuntime},{TextDocuments},{TencentClient},{TencentResults},{hash},{ModelClient},{TextStructures},{validateSourceFields},{TextAssembler},{assembleTextUnits}]=await Promise.all(['ai-database','ai-storage','checkpoints','graph-store','document-tasks','document-runtime','text-documents','tencent','tencent-results','assets','model','text-structures','source-fields','text-assembler','text-assembly'].map(name=>import(new URL(name+'.js',workerData.moduleUrl).href)));
        const nativeEvidence=ocrSourceEvidence({page:1,format:'table',figures:[],elements:[{layout_xml:'<table><td>Q</td><td>A</td></table>',table_info:{table_name:'Science',fields:[{formatted_field_name:'Question'}]}}]}),nativeParsed=validateSourceFields({questions:[{id:'page:1:1',stem:'Q',answerMode:'short_answer',questionTypeId:'Short answer',answerPayload:{text:'A'},sourceScore:0.29}],groups:[{title:'Science',questionIndexes:[0]}]},{index:0,expectedNodeCount:1,presence:null,ocr:nativeEvidence});
        const nativeOcr={text:nativeEvidence.text,group:nativeParsed.groups[0].title,sourceScore:nativeParsed.questions[0].sourceScore};
        const assert=require('node:assert/strict');
        const [{validateParsedQuestion},{retainSourceAnswers},{sourceContext},{validatePageFigure,tableMarkdown},{completePageResult},{validateOcrPageAssociations},{assembleOcrUnits},{parseModelJson},{schemaFor}]=await Promise.all(['question-contract','answer-evidence','source-context','page-figures','page-projection','ocr-associations','ocr-assembly','ai-json','contract-source'].map(name=>import(new URL(name+'.js',workerData.moduleUrl).href)));
        const question=validateParsedQuestion({id:'fragment:1:1',stem:'Prompt?',questionTypeId:'Short answer',answerMode:'short_answer',answerPayload:{text:'Supplied'},needsReview:false,confidence:1});
        const unproven=structuredClone(question);retainSourceAnswers([unproven],'1. Short answer: Prompt?',[],null);assert.equal(unproven.answerPayload,null);assert.equal(unproven.needsReview,true);
        const proven=structuredClone(question);retainSourceAnswers([proven],'1. Short answer: Prompt?\\nReference answer: Supplied',[],null);assert.deepEqual(proven.answerPayload,{text:'Supplied'});
        const source='1. Short answer: Prompt?\\nReference answer: Supplied',unit={index:0,payload:{parsed:{questions:[question],groups:[]},visuals:[]}},span={start:0,end:source.length,overlapStart:0,overlapEnd:0};
        const assembled=assembleTextUnits([unit],source,[span],{});assert.equal(assembled.result.questions.length,1);assert.deepEqual(assembled.result.questions[0].answerPayload,{text:'Supplied'});assert.equal(unit.payload.parsed.questions[0].id,'fragment:1:1');
        const figure=validatePageFigure({kind:'table',description:'Source table',bbox:[0,0,1,1],questionIndexes:[0],tableRows:[['Answer','Value'],['1','Supplied']]});assert.equal(figure.role,'answer');assert.ok(tableMarkdown(figure).includes('Supplied'));
        const projected=completePageResult({questions:[question],groups:[],figures:[figure]},2,[]);assert.equal(projected.visuals[0].bbox,null);assert.equal(projected.parsed.questions[0].contentBlocks[0].role,'answer');
        assert.deepEqual(sourceContext([{elements:[{text_info:{content:'1. Prompt?'}}]},{elements:[{text_info:{content:'Answers\\n1. Supplied'}}]}])[0][0],[0,1]);
        assert.throws(()=>validateOcrPageAssociations({questions:[question],figures:[{elementIndex:99,description:'Invented'}]},[],{index:0,expectedNodeCount:null,presence:null,ocr:{text:'Prompt?'}}));
        const ocrAssembled=await assembleOcrUnits([{index:0,payload:{parsed:{questions:[question],groups:[]},visuals:[]}}],[{page:0,elements:[{text_info:{content:source}}]}],{pageRefs:[],failures:[],visualTotal:0,sourceType:'pdf'},async visuals=>({visuals,failures:[],truncated:false,limit:10}));assert.equal(ocrAssembled.result.questions.length,1);
        assert.throws(()=>parseModelJson('{"figures":[{"elementIndex":1.0}]}',schemaFor('OcrPageParseResult')));
        assert.throws(()=>parseModelJson('{"questions":[{"answerPayload":{"order":[1e0]},"answerMode":"ordering"}]}',schemaFor('UnitParseResult')));
        assert.deepEqual(parseModelJson('{"questions":[{"sourceScore":1.0,"contentBlocks":[{"jsonValue":{"n":1e0}}]}]}',schemaFor('UnitParseResult')),{questions:[{sourceScore:1,contentBlocks:[{jsonValue:{n:1}}]}]});
        const sourceProofs={literalAnswers:true,textAssembly:true,tableAnswerRoles:true,unverifiedBounds:true,linkedAnswerPages:true,fixedFigureIds:true,ocrAssembly:true,strictModelNumbers:true};
        const database=new AiDatabase(workerData.directory), storage=new AiStorage(workerData.directory), checkpoints=new SqliteCheckpoints(workerData.directory), store=new SqliteStore(workerData.directory), tasks=new DocumentTasks(workerData.directory,storage,database);
        let submissions=0,modelCalls=0;
        const model=new ModelClient(database,async(_url,init)=>{
          modelCalls++;const request=JSON.parse(init.body);if(!request.input[0].content[0].text.includes('Extract assessment questions faithfully from the supplied fragment.'))throw new Error('Missing original extraction instructions');if(modelCalls===2&&!(request.input[2].role==='assistant'&&request.input[3].content.includes('questionTypeId')))throw new Error('Missing durable correction context');
          const parsed=JSON.stringify({questions:[{id:'fragment:1:1',stem:'first',answerMode:'short_answer',questionTypeId:modelCalls===1?null:'Short answer',answerPayload:null,sourceText:'first',analysis:null,confidence:.9,needsReview:true}],groups:[]});
          return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',name:'UnitParseResult',arguments:modelCalls===2?parsed.slice(0,-1)+',}':parsed}],usage:{input_tokens:10,output_tokens:5}}));
        });
        const client=new TencentClient(database,async(url,init)=>{
          const action=new Headers(init.headers).get('X-TC-Action');
          if(action==='SubmitMultimodalDocParseJob')return new Response(JSON.stringify({Response:{TaskId:'job-'+submissions++}}));
          if(action==='DescribeMultimodalDocParseJob'){const id=JSON.parse(init.body).TaskId.split('-')[1];return new Response(JSON.stringify({Response:{Status:'Success',SuccessPageNum:1,FailPageNum:0,ResultUrl:'https://result.cos.ap-guangzhou.myqcloud.com/'+id+'?signature=TEST_ONLY'}}));}
          return new Response(Buffer.from(workerData.textResults[Number(new URL(url).pathname.slice(1))],'base64'));
        }), documents=new TextDocuments(storage,new TencentResults(client,storage),{inputBytes:8}), structures=new TextStructures(storage,model), assembler=new TextAssembler(storage),runtime=new DocumentRuntime(tasks,checkpoints,{prepare:context=>documents.prepare(context),recognize:context=>documents.recognize(context),structure:context=>structures.structure(context),assemble:context=>assembler.assemble(context)},store);
        let text,mergePreview,ocrGraph,ocrRuntime,rasterRuntime;const rasterGraphs=[];
        try{
          const config={revision:'test',preferences:{model:{provider:'openai',baseUrl:'https://provider.example/v1',modelId:'model',maxOutputTokens:2000,timeoutSeconds:10},import:{tencentConcurrency:2,readRetryCount:0,retryBaseSeconds:0.5},maxCalls:10,tencentCos:{enabled:false,bucket:'',region:''}},secrets:{modelApiKey:'TEST_ONLY',tencentSecretId:'TEST_ONLY',tencentSecretKey:'TEST_ONLY'}};
          const bytes=Buffer.from(workerData.text), sha256=hash(bytes), source={fileName:'source.txt',sourceType:'text',mediaType:'text/plain',sizeBytes:bytes.length,sha256,objectKey:sourceKey('text',sha256)};
          await storage.putSource(source,bytes);const receipt=await runtime.create({requestId:require('node:crypto').randomUUID(),document:source,graphId:'document_parser'},config);await runtime.wait(receipt.threadId);
          const record=tasks.record(receipt.threadId), recognized=JSON.parse(storage.artifact(record.outputs.recognize.manifest).toString()), chunks=JSON.parse(storage.artifact(recognized.chunkManifest).toString());
          const structured=JSON.parse(storage.artifact(record.outputs.structure.manifest).toString());
          const unit=structured.units[0],unitBytes=storage.artifact(unit.resultRef),finalized=tasks.result(record),processing=tasks.processing(record);assert.equal(record.state,'COMPLETED');assert.equal(record.outputs.assemble.status,'SUCCEEDED');assert.equal(finalized.questions[0].answerPayload,null);assert.equal(finalized.questions[0].needsReview,true);assert.equal(tasks.readArtifact(record.id,record.outputs.assemble.result).equals(storage.artifact(record.outputs.assemble.result)),true);
          mergePreview={nodes:finalized.questions.length,id:finalized.questions[0].id,sourceUnit:processing.questionSources[0].unitIndex,immutableUnit:storage.artifact(unit.resultRef).equals(unitBytes)};
          text={submissions,parts:recognized.inputParts.length,exact:storage.artifact(recognized.textRef).equals(bytes),chunks:chunks.chunkRefs.length,chunkBytesExact:Buffer.concat(chunks.chunkRefs.map(ref=>storage.artifact(ref))).equals(bytes),modelCalls,modelStatuses:database.db.prepare("SELECT status FROM ai_calls WHERE endpoint!='https://ocr.tencentcloudapi.com' ORDER BY call_key").all().map(row=>row.status),unitSaved:structured.units.length===1&&structured.units[0].status==='succeeded',stoppedAt:record.failedStage,code:record.errorCode};
          let ocrSubmissions=0,ocrModelCalls=0;
          const ocrClient=new TencentClient(database,async(_url,init)=>{const action=new Headers(init.headers).get('X-TC-Action');if(action==='SubmitMultimodalDocParseJob'){ocrSubmissions++;return new Response(JSON.stringify({Response:{TaskId:'known-ocr-job'}}));}if(action==='DescribeMultimodalDocParseJob')return new Response(JSON.stringify({Response:{Status:'Success',SuccessPageNum:1,FailPageNum:0,ResultUrl:'https://result.cos.ap-guangzhou.myqcloud.com/ocr?signature=TEST_ONLY'}}));return new Response(Buffer.from(workerData.textResults[0],'base64'));}),ocrDocuments=new TextDocuments(storage,new TencentResults(ocrClient,storage)),ocrModel=new ModelClient(database,async(_url,init)=>{ocrModelCalls++;const request=JSON.parse(init.body);assert.equal(request.tools[0].name,'OcrPageParseResult');assert.match(request.input[1].content[0].text,/PRIMARY is page 1/);return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',name:'OcrPageParseResult',arguments:JSON.stringify({questions:[{id:'page:1:1',stem:'first',answerMode:'short_answer',questionTypeId:'Short answer',answerPayload:null,sourceText:'first',confidence:.9,needsReview:true}],groups:[],figures:[]})}],usage:{input_tokens:10,output_tokens:5}}));}),ocrStructures=new TextStructures(storage,ocrModel);
          ocrRuntime=new DocumentRuntime(tasks,checkpoints,{prepare:context=>ocrDocuments.prepare(context),recognize:context=>ocrDocuments.recognize(context),structure:context=>ocrStructures.structure(context),assemble:context=>assembler.assemble(context)},store);
          const ocrBytes=Buffer.from('Different original source'),ocrSha=hash(ocrBytes),ocrSource={fileName:'ocr.txt',sourceType:'text',mediaType:'text/plain',sizeBytes:ocrBytes.length,sha256:ocrSha,objectKey:sourceKey('text',ocrSha)};await storage.putSource(ocrSource,ocrBytes);const ocrReceipt=await ocrRuntime.create({requestId:require('node:crypto').randomUUID(),document:ocrSource},config);await ocrRuntime.wait(ocrReceipt.threadId);
          const ocrRecord=tasks.record(ocrReceipt.threadId),ocrManifest=JSON.parse(storage.artifact(ocrRecord.outputs.structure.manifest).toString()),ocrUnit=JSON.parse(storage.artifact(ocrManifest.units[0].resultRef).toString());assert.equal(ocrUnit.parsed.questions[0].stem,'first');
          assert.equal(ocrRecord.state,'COMPLETED');assert.equal(ocrRecord.outputs.assemble.status,'SUCCEEDED');assert.equal(tasks.result(ocrRecord).questions[0].id,'q0');assert.equal(ocrUnit.parsed.questions[0].id,'page:1:1');assert.equal(tasks.detail(ocrRecord.id,config).processing.questionSources[0].stage,'vision_parse');
          await assert.rejects(()=>ocrRuntime.control(ocrRecord.id,{requestId:require('node:crypto').randomUUID(),action:'resume',checkpointId:ocrRecord.checkpointId},config),{code:'INVALID_CONTROL'});
          ocrGraph={submissions:ocrSubmissions,modelCalls:ocrModelCalls,unitSaved:ocrManifest.units.length===1&&ocrManifest.units[0].status==='succeeded',status:ocrRecord.outputs.assemble.status,sourceStage:tasks.detail(ocrRecord.id,config).processing.questionSources[0].stage,stoppedAt:ocrRecord.failedStage,code:ocrRecord.errorCode};
          const {SOURCE_FORMATS}=await import(new URL('ai-storage.js',workerData.moduleUrl).href);
          for(const [index,kind] of ['pdf','image','docx','xlsx','pptx','ppt'].entries()){
            let rasterSubmissions=0,cosUploads=0,cosDeletes=0,stagedBytes,submittedBytes;const privateCos=kind==='docx'||kind==='pptx',runConfig=structuredClone(config);if(privateCos)runConfig.preferences.tencentCos={enabled:true,bucket:'fixture-1250000000',region:'ap-guangzhou'};const beforeModel=ocrModelCalls,rasterClient=new TencentClient(database,async(_url,init)=>{if(init.method==='PUT'){stagedBytes=Buffer.from(init.body);cosUploads++;assert.equal(new Headers(init.headers).get('x-cos-acl'),'private');assert.equal(new Headers(init.headers).get('x-cos-server-side-encryption'),'AES256');return new Response(null,{headers:{ETag:'\"'+require('node:crypto').createHash('md5').update(init.body).digest('hex')+'\"'}});}if(init.method==='DELETE'){cosDeletes++;return new Response(null,{status:204});}const action=new Headers(init.headers).get('X-TC-Action');if(action==='SubmitMultimodalDocParseJob'){const body=JSON.parse(init.body);assert.equal(body.ResultType,9);if(privateCos){assert.equal(body.FileBase64,undefined);assert.equal(body.FileUrl.startsWith('https://fixture-'),true);}submittedBytes=privateCos?stagedBytes:Buffer.from(body.FileBase64,'base64');rasterSubmissions++;return new Response(JSON.stringify({Response:{TaskId:'raster-job'}}));}if(action==='DescribeMultimodalDocParseJob')return new Response(JSON.stringify({Response:{Status:'Success',SuccessPageNum:1,FailPageNum:0,ResultUrl:'https://result.cos.ap-guangzhou.myqcloud.com/raster?signature=TEST_ONLY'}}));return new Response(Buffer.from(workerData.rasterResult,'base64'));}),rasterDocuments=new TextDocuments(storage,new TencentResults(rasterClient,storage));
            rasterRuntime=new DocumentRuntime(tasks,checkpoints,{prepare:context=>rasterDocuments.prepare(context),recognize:context=>rasterDocuments.recognize(context),structure:context=>ocrStructures.structure(context),assemble:context=>assembler.assemble(context)},store);
            const bytes=Buffer.from(workerData.rasterSources[index],'base64'),sha256=hash(bytes),source={...SOURCE_FORMATS[kind==='image'?'png':kind],fileName:'source.'+(kind==='image'?'png':kind),sizeBytes:bytes.length,sha256,objectKey:sourceKey(kind,sha256)};await storage.putSource(source,bytes);const receipt=await rasterRuntime.create({requestId:require('node:crypto').randomUUID(),document:source},runConfig);await rasterRuntime.wait(receipt.threadId);const record=tasks.record(receipt.threadId);assert.equal(record.state,'COMPLETED');const recognized=JSON.parse(storage.artifact(record.outputs.recognize.manifest).toString()),prepared=JSON.parse(storage.artifact(record.outputs.prepare.manifest).toString());assert.equal(recognized.version,index<2?2:3);assert.equal(recognized.textRef,null);assert.equal(recognized.pageRefs.length,1);assert.equal(storage.source(source).equals(bytes),true);assert.equal(tasks.result(record).questions[0].stem,'first');if(kind==='xlsx'){assert.equal(prepared.preparation,'visible_excel_sheets');assert.notEqual(prepared.submission.sha256,source.sha256);assert.equal(recognized.truncated,true);}
            if(privateCos){assert.deepEqual([cosUploads,cosDeletes],[1,1]);assert.equal(rasterClient.job(record.id,'source-0-0').staging.deleted,true);assert.equal(JSON.stringify(database.state(record.id)).includes('q-signature'),false);}
            if(kind==='pptx'){assert.equal(prepared.preparation,'visible_powerpoint_slides');assert.equal(prepared.slides.length,2);assert.equal(submittedBytes.equals(storage.artifact(prepared.submission)),true);const {BoundedZip}=await import(new URL('zip.js',workerData.moduleUrl).href),zip=await BoundedZip.fromBytes(submittedBytes,{archiveBytes:25*1024*1024,expandedBytes:100*1024*1024,entries:10000,allowDirectories:true,extraCodecs:true});try{assert.equal((await zip.read('ppt/slides/slide2.xml',2*1024*1024)).toString().includes('show="true"'),true);}finally{zip.close();}assert.equal(recognized.truncated,true);assert.equal(recognized.warnings.some(text=>text.includes('fewer pages than declared presentation slides')),true);}
            if(kind==='ppt'){assert.equal(prepared.preparation,'visible_powerpoint_slides');assert.equal(prepared.slides.length,2);assert.equal(hash(submittedBytes),workerData.legacyPptExpected);assert.equal(submittedBytes.equals(storage.artifact(prepared.submission)),true);assert.equal(recognized.truncated,true);assert.equal(recognized.warnings.some(text=>text.includes('fewer pages than declared presentation slides')),true);}
            rasterGraphs.push({sourceType:kind,submissions:rasterSubmissions,modelCalls:ocrModelCalls-beforeModel,status:record.outputs.assemble.status,engine:prepared.engine?.kind??'office-metadata',pageImages:recognized.pageRefs.filter(ref=>ref.mediaType.startsWith('image/')).length,...(['pptx','ppt'].includes(kind)?{hiddenSlidesVisible:true,declaredSlides:prepared.slides.length}:{})});
          }
        }finally{runtime.abortAll();ocrRuntime?.abortAll();rasterRuntime?.abortAll();store.stop();checkpoints.close();tasks.close();database.close();}
        parentPort.postMessage({electron:process.versions.electron,node:process.versions.node,results,text,nativeOcr,mergePreview,sourceProofs,ocrGraph,rasterGraphs});
      }).catch(error=>{throw error;});
    `, { eval: true, workerData: input, execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<{ electron: string; node: string; results: { method: string; bytes: number; mediaType: string }[]; text: { submissions: number; parts: number; exact: boolean; chunks: number; chunkBytesExact: boolean; modelCalls: number; modelStatuses: string[]; unitSaved: boolean; stoppedAt: string | null; code: string | null }; ocrGraph: { submissions: number; modelCalls: number; unitSaved: boolean; status: string; sourceStage: string; stoppedAt: string | null; code: string | null }; nativeOcr: { text: string; group: string; sourceScore: number }; mergePreview: { nodes: number; id: string; sourceUnit: number; immutableUnit: boolean }; sourceProofs: Record<string, boolean> }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Electron codec worker timed out")), 15_000); worker.once("message", resolve); worker.once("error", reject); worker.once("exit", code => { if (code) reject(new Error("Electron codec worker stopped")); });
      });
    } finally { clearTimeout(timer); await worker.terminate(); }
  }, { moduleUrl: pathToFileURL(join(runtimeDirectory, "tencent-bundle.js")).href, cases: codecCases, directory: join(directory, "text-worker"), text: "first\nsecond\n", textResults, rasterResult, rasterSources, legacyPptExpected });
  assert.deepEqual(codecReport.results.map(value => value.method), ["0", "8", "12", "14", "93"]); assert.equal(codecReport.results.every(value => value.bytes > 0 && value.mediaType === "image/png"), true);
  assert.deepEqual(codecReport.text, { submissions: 2, parts: 2, exact: true, chunks: 1, chunkBytesExact: true, modelCalls: 2, modelStatuses: ["failed", "succeeded"], unitSaved: true, stoppedAt: null, code: null });
  assert.deepEqual(codecReport.nativeOcr, { text: "Q\nA", group: "Science", sourceScore: 0.29 });
  assert.deepEqual(codecReport.mergePreview, { nodes: 1, id: "q0", sourceUnit: 0, immutableUnit: true });
  assert.deepEqual(codecReport.ocrGraph, { submissions: 1, modelCalls: 1, unitSaved: true, status: "SUCCEEDED", sourceStage: "vision_parse", stoppedAt: null, code: null });
  assert.deepEqual((codecReport as typeof codecReport & { rasterGraphs: unknown }).rasterGraphs, [{ sourceType: "pdf", submissions: 1, modelCalls: 1, status: "SUCCEEDED", engine: "pdfium", pageImages: 1 }, { sourceType: "image", submissions: 1, modelCalls: 1, status: "SUCCEEDED", engine: "sharp", pageImages: 1 }, { sourceType: "docx", submissions: 1, modelCalls: 1, status: "SUCCEEDED", engine: "office-metadata", pageImages: 0 }, { sourceType: "xlsx", submissions: 1, modelCalls: 1, status: "PARTIAL", engine: "office-metadata", pageImages: 0 }, { sourceType: "pptx", submissions: 1, modelCalls: 1, status: "PARTIAL", engine: "office-metadata", pageImages: 0, hiddenSlidesVisible: true, declaredSlides: 2 }, { sourceType: "ppt", submissions: 1, modelCalls: 1, status: "PARTIAL", engine: "office-metadata", pageImages: 0, hiddenSlidesVisible: true, declaredSlides: 2 }]);
  assert.deepEqual(codecReport.sourceProofs, { literalAnswers: true, textAssembly: true, tableAnswerRoles: true, unverifiedBounds: true, linkedAnswerPages: true, fixedFigureIds: true, ocrAssembly: true, strictModelNumbers: true });
  assert.match(await readFile(join(runtimeDirectory, "resources/unicode-data.txt"), "utf8"), /^UNICODE LICENSE V3/);
  await mkdir(".build/evidence", { recursive: true }); await writeFile(".build/evidence/electron-tencent-codecs.json", JSON.stringify(codecReport, null, 2));
  const bridge = async (request: unknown) => page.evaluate(async input => {
    return (window as unknown as { practiq: { request(value: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> } }).practiq.request(input);
  }, request);
  // waitForFunction treats an async predicate's Promise as truthy before it settles.
  async function waitForBridge(request: unknown, accept: (reply: Awaited<ReturnType<typeof bridge>>) => boolean) {
    const deadline = Date.now() + 15_000;
    for (;;) { const reply = await bridge(request); if (accept(reply)) return reply; assert.ok(Date.now() < deadline, "Native state did not reach its expected value"); await delay(50); }
  }
  assert.deepEqual(await bridge({ type: "banks" }), { ok: true, value: [] });
  const initialAi = await bridge({ type: "ai_settings" }); assert.equal(initialAi.ok, true);
  const settings = initialAi.value as { revision: string; preferences: { model: Record<string, unknown>; tencentCos: { enabled: boolean; bucket: string; region: string } }; configured: Record<string, boolean> };
  assert.deepEqual(settings.configured, { modelApiKey: false, tencentSecretId: false, tencentSecretKey: false });
  const savedAi = await bridge({ type: "save_ai_settings", value: { revision: settings.revision, preferences: { ...settings.preferences, model: { ...settings.preferences.model, baseUrl: "https://model.example/v1", modelId: "configured-without-submitting" } } } }); assert.equal(savedAi.ok, true);
  assert.equal(JSON.stringify(savedAi).includes('"secrets"'), false);
  const sourcePath = join(directory, "native-source.txt"); await writeFile(sourcePath, "原始文档，选文件不会调用模型。");
  await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, sourcePath);
  const sourceSelection = await bridge({ type: "pick_document_sources" }); assert.equal(sourceSelection.ok, true); assert.equal(JSON.stringify(sourceSelection).includes(directory), false);
  const sourceTicket = (sourceSelection.value as { nativeTicket: string; name: string }[])[0]; assert.equal(sourceTicket.name, "native-source.txt");
  const sourceStored = await bridge({ type: "upload_document_source", ticket: sourceTicket.nativeTicket }); assert.equal(sourceStored.ok, true); assert.equal(JSON.stringify(sourceStored).includes(directory), false);
  assert.deepEqual(await bridge({ type: "upload_document_source", ticket: sourceTicket.nativeTicket }), sourceStored);
  const documentRevision = (savedAi.value as typeof settings).revision;
  assert.deepEqual(await bridge({ type: "document_request", request: { type: "list", revision: documentRevision, offset: 0, limit: 20, state: "" } }), { ok: true, value: { type: "list", value: { items: [], hasMore: false, nextCursor: null } } });
  const documentRequest = { type: "create", revision: documentRevision, value: { requestId: randomUUID(), document: sourceStored.value } };
  assert.equal((await bridge({ type: "document_request", request: documentRequest })).error?.code, "MODEL_NOT_CONFIGURED");
  assert.equal((await bridge({ type: "document_request", request: { ...documentRequest, revision: randomUUID() } })).error?.code, "LOCAL_SETTINGS_CHANGED");
  assert.equal((await bridge({ type: "document_request", request: documentRequest, config: { secrets: {} } })).error?.code, "LOCAL_FILTER_INVALID");
  const aiState = new DatabaseSync(join(practiceDirectory, "ai.sqlite"), { readOnly: true });
  try { assert.equal(aiState.prepare("SELECT COUNT(*) AS count FROM ai_calls").get()!.count, 0); assert.equal(aiState.prepare("SELECT COUNT(*) AS count FROM ai_tasks").get()!.count, 0); } finally { aiState.close(); }
  assert.equal(modelCalls, 0);
  const documentDownload = join(directory, "source-download.txt");
  await instance.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, documentDownload);
  assert.deepEqual(await page.evaluate(() => window.practiq!.request({ type: "save_document_bytes", bytes: new TextEncoder().encode("verified download").buffer, name: "source.txt" })), { ok: true, value: true });
  assert.equal(await readFile(documentDownload, "utf8"), "verified download");
  assert.equal((await page.evaluate(() => window.practiq!.request({ type: "save_document_bytes", bytes: new TextEncoder().encode("replacement").buffer, name: "source.txt" }))).ok, false);
  assert.equal(await readFile(documentDownload, "utf8"), "verified download");
  assert.equal((await page.evaluate(() => window.practiq!.request({ type: "save_document_bytes", bytes: new ArrayBuffer(1), name: "../outside.txt" }))).ok, false);
  const largeDownload = join(directory, "large-source.bin");
  await instance.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, largeDownload);
  assert.deepEqual(await page.evaluate(() => { const bytes = new Uint8Array(17 * 1024 * 1024).fill(127); return window.practiq!.request({ type: "save_document_bytes", bytes: bytes.buffer, name: "source.bin" }); }), { ok: true, value: true });
  const savedBytes = await readFile(largeDownload); assert.equal(savedBytes.length, 17 * 1024 * 1024); assert.equal(savedBytes.every(value => value === 127), true);
  await instance.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" }); });
  assert.deepEqual(await page.evaluate(() => window.practiq!.request({ type: "save_document_bytes", bytes: new ArrayBuffer(1), name: "source.bin" })), { ok: true, value: false });
  const sourceSettings = savedAi.value as typeof settings;
  assert.equal((await bridge({ type: "save_ai_settings", value: { revision: sourceSettings.revision, preferences: { ...sourceSettings.preferences, model: { ...sourceSettings.preferences.model, modelId: "changed-without-submitting" } } } })).ok, true);
  assert.equal((await bridge({ type: "upload_document_source", ticket: sourceTicket.nativeTicket })).error?.code, "CLOUD_FILE_RESELECT");
  const changedSelection = await bridge({ type: "pick_document_sources" }); assert.equal(changedSelection.ok, true);
  await writeFile(sourcePath, "文件选中后发生变化。");
  assert.equal((await bridge({ type: "upload_document_source", ticket: (changedSelection.value as { nativeTicket: string }[])[0].nativeTicket })).error?.code, "DOCUMENT_CHECKSUM_MISMATCH");
  assert.equal((await bridge({ type: "pick_document_sources", path: sourcePath })).error?.code, "LOCAL_FILTER_INVALID");
  assert.equal((await bridge({ type: "upload_document_source", ticket: sourceTicket.nativeTicket, path: sourcePath })).error?.code, "LOCAL_FILTER_INVALID");
  await instance.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.deepEqual(await bridge({ type: "pick_document_sources" }), { ok: true, value: [] });
  const saved = await bridge({ type: "save_bank", id: null, title: "Electron 验证", description: "真实 IPC 和 SQLite" });
  assert.equal(saved.ok, true);
  const id = saved.value;
  assert.equal(typeof id, "string");
  assert.deepEqual(await bridge({ type: "banks" }), { ok: true, value: [{ id, title: "Electron 验证", count: 0 }] });
  assert.equal((await bridge({ type: "save_bank", id, title: "字".repeat(16), description: "" })).error?.code, "LOCAL_NAME_INVALID");
  assert.equal((await bridge({ type: "save_bank", id, title: "valid", description: "述".repeat(51) })).error?.code, "LOCAL_DESCRIPTION_TOO_LONG");
  assert.equal((await bridge({ type: "banks", path: "/private" })).error?.code, "LOCAL_FILTER_INVALID");
  assert.equal((await bridge({ type: "save_question_tree", bank_id: id, root_id: null, questions: [{ id: "smoke-question", stem: "Electron 判断验证", questionTypeId: "判断题", answerMode: "true_false", answerPayload: { value: true }, analysis: "验证判分", sourceText: "原始内容", needsReview: false }] })).ok, true);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByText("Electron 验证", { exact: true }).waitFor();
  await page.getByRole("button", { name: "新建题库", exact: true }).click();
  await page.getByLabel("题库名称", { exact: true }).fill("界面验证");
  await page.getByLabel("说明", { exact: true }).fill("通过真实窗口保存");
  await page.getByRole("button", { name: "保存题库", exact: true }).click();
  await page.getByText("界面验证", { exact: true }).waitFor();
  await page.getByRole("button", { name: "新建题库", exact: true }).click();
  await page.getByLabel("题库名称", { exact: true }).fill("未保存编辑");
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByText("放弃未保存的更改并退出？", { exact: true }).waitFor();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.getByLabel("题库名称", { exact: true }).inputValue(), "未保存编辑");
  await page.getByRole("button", { name: "放弃更改", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "放弃更改", exact: true }).click();
  await page.getByLabel("题库名称", { exact: true }).waitFor({ state: "hidden" });
  const card = page.locator('[data-slot="card"]').filter({ has: page.getByText("Electron 验证", { exact: true }) });
  await card.getByRole("button", { name: "开始练习", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "立即开始", exact: true }).click();
  await page.getByText("Electron 判断验证", { exact: true }).waitFor();
  await page.getByRole("radio", { name: "正确", exact: true }).click();
  await page.getByRole("button", { name: /提交答案/ }).click();
  await page.getByText("回答正确", { exact: true }).waitFor();
  await page.getByRole("button", { name: "结束练习", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "提交草稿并结束", exact: true }).click();
  await page.getByRole("heading", { name: "练习回顾", exact: true }).waitFor();
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "我的题库", exact: true }).click();
  await mkdir(".build/evidence", { recursive: true });
  await page.screenshot({ path: ".build/evidence/electron-smoke.png" });
  assert.deepEqual(await bridge({ type: "delete_bank", id }), { ok: true, value: null });
  const banks = await bridge({ type: "banks" });
  assert.equal((banks.value as { title: string }[]).length, 1);
  assert.equal((banks.value as { title: string }[])[0].title, "界面验证");
  stage = "OS credential initialization";
  await writeFile(receipt, JSON.stringify({ checkedAt: new Date().toISOString(), ...installation, stage, passed: false, systemOnlyPath: Boolean(executable), runtimeDirectory, offlineCrudAndPractice: true, compiledDocumentGraphs: codecReport, nativeDialogs: "substituted", providerCalls: "local substitutes" }, null, 2) + "\n");
  assert.equal(await instance.evaluate(async ({ safeStorage }) => safeStorage.isAsyncEncryptionAvailable()), true);
  stage = "OS-encrypted settings";
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("模型 API 地址", { exact: true }).fill(modelOrigin);
  assert.ok((await page.getByLabel("模型 API 地址", { exact: true }).boundingBox())!.width >= 250);
  assert.ok((await page.getByLabel(/^模型 API Key/).boundingBox())!.width >= 180);
  await page.getByLabel("模型 ID", { exact: true }).fill("local-smoke-model");
  await page.getByLabel(/^模型 API Key/).fill("TEST_ONLY_ENCRYPTED_KEY");
  await page.getByRole("button", { name: "保存 AI 设置", exact: true }).click();
  await waitForBridge({ type: "ai_settings" }, reply => reply.ok && (reply.value as { preferences: { model: { baseUrl: string } } }).preferences.model.baseUrl === modelOrigin);
  let encryptedAi = await bridge({ type: "ai_settings" });
  assert.equal(encryptedAi.ok, true); assert.equal(JSON.stringify(encryptedAi).includes("TEST_ONLY_ENCRYPTED_KEY"), false);
  assert.equal((await readFile(join(practiceDirectory, "electron-ai-settings-v1.json"), "utf8")).includes("TEST_ONLY_ENCRYPTED_KEY"), false);
  await page.getByRole("heading", { name: "AI 模型与识别", exact: true }).waitFor();
  await page.screenshot({ path: ".build/evidence/electron-ai-settings.png" });
  await page.getByText("私有 COS 暂存（高级，可选）", { exact: true }).click(); await page.getByLabel("启用私有 COS 暂存", { exact: true }).click();
  await page.getByLabel("COS 存储桶（含 APPID）", { exact: true }).fill("fixture-1250000000"); await page.getByLabel("COS 地域", { exact: true }).fill("ap-guangzhou"); await page.getByRole("button", { name: "保存 AI 设置", exact: true }).click();
  await waitForBridge({ type: "ai_settings" }, reply => reply.ok && (reply.value as typeof settings).preferences.tencentCos.enabled); await page.getByRole("button", { name: "保存 AI 设置", exact: true }).waitFor();
  const cosSettings = (await bridge({ type: "ai_settings" })).value as typeof settings;
  const cosCapabilities = await bridge({ type: "document_request", request: { type: "capabilities", revision: cosSettings.revision } }); assert.equal(cosCapabilities.ok, true); assert.equal((cosCapabilities.value as { value: { officeSourceMaxBytes: number } }).value.officeSourceMaxBytes, 25 * 1024 * 1024);
  await page.getByText("私有 COS 暂存（高级，可选）", { exact: true }).click(); await page.screenshot({ path: ".build/evidence/electron-private-cos-settings.png" });
  await page.getByLabel("启用私有 COS 暂存", { exact: true }).click(); await page.getByRole("button", { name: "保存 AI 设置", exact: true }).click(); await waitForBridge({ type: "ai_settings" }, reply => reply.ok && !(reply.value as typeof settings).preferences.tencentCos.enabled); await page.getByRole("button", { name: "保存 AI 设置", exact: true }).waitFor();
  encryptedAi = await bridge({ type: "ai_settings" }); assert.equal(modelCalls, 0); assert.equal((encryptedAi.value as typeof settings).configured.modelApiKey, true);
  await page.getByText("费用预留限制（可选）", { exact: true }).click(); await page.getByLabel("启用费用预留限制", { exact: true }).click();
  for (const [label, value] of [["预算币种（三位大写代码）", "CNY"], ["单任务费用限额", "0.000001"], ["UTC 每日费用限额", "0.000001"], ["模型输入价格（每百万估算 tokens）", "0.000001"], ["模型输出价格（每百万 tokens）", "0.000001"], ["腾讯识别价格（每页）", "0.000001"]]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "保存 AI 设置", exact: true }).click(); await waitForBridge({ type: "ai_settings" }, reply => reply.ok && Boolean((reply.value as { preferences: { cost?: { enabled: boolean } } }).preferences.cost?.enabled)); await page.getByRole("button", { name: "保存 AI 设置", exact: true }).waitFor();
  const budgetPreferences = ((await bridge({ type: "ai_settings" })).value as typeof settings).preferences;
  const budgetProbe = await instance.evaluate(async (_electron, data) => {
    const { Worker } = process.getBuiltinModule("node:worker_threads"), worker = new Worker(`
      const { parentPort, workerData: d } = require('node:worker_threads');
      (async()=>{const get=n=>import(d.base+n+'.js'),[{AiDatabase},{SqliteStore},{CostBudget},{savedCostPolicy},{ModelClient},{hash}]=await Promise.all(['ai-database','graph-store','cost-budget','ai-settings','model','assets'].map(get));const db=new AiDatabase(d.directory),store=new SqliteStore(d.directory),costs=new CostBudget(store,()=>savedCostPolicy(d.directory));let calls=0;
        try{const task=db.createTask(hash('native cost acceptance'),2),model=new ModelClient(db,async()=>{calls++;return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',name:'UnitParseResult',arguments:'{"questions":[],"groups":[]}'}],usage:{input_tokens:2,output_tokens:1}}));});model.bindCosts(costs);const config={revision:crypto.randomUUID(),preferences:d.preferences,secrets:{modelApiKey:'TEST_ONLY',tencentSecretId:'',tencentSecretKey:''}},input={schema:'UnitParseResult',promptVersion:'native-cost',system:'Extract',text:'Known source'};await model.structured(task,'first',input,config);let blocked;try{await model.structured(task,'second',input,config);}catch(error){blocked=error.code;}const report=await costs.report();parentPort.postMessage({calls,blocked,reserved:report.day.reservedMicros,secondClaim:db.receipt(task,'second')});}
        finally{store.stop();db.close();}
      })().catch(error=>parentPort.postMessage({error:error.message}));
    `, { eval: true, workerData: data, env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await new Promise<{ calls: number; blocked: string; reserved: number; secondClaim: null }>((resolve, reject) => { timer = setTimeout(() => reject(Error("Cost probe timed out")), 15000); worker.once("message", value => value.error ? reject(Error(value.error)) : resolve(value)); worker.once("error", reject); worker.once("exit", code => { if (code) reject(Error("Cost probe stopped")); }); }); } finally { clearTimeout(timer); await worker.terminate(); }
  }, { base: pathToFileURL(runtimeDirectory + "/").href, directory: practiceDirectory, preferences: budgetPreferences });
  assert.deepEqual(budgetProbe, { calls: 1, blocked: "COST_BUDGET_EXCEEDED", reserved: 1, secondClaim: null });
  await page.getByRole("button", { name: "读取费用预留", exact: true }).click(); await page.getByText("当日已预留：CNY 0.000001", { exact: true }).waitFor(); await page.screenshot({ path: ".build/evidence/electron-cost-budget.png" });
  await page.getByText("费用预留限制（可选）", { exact: true }).click(); await page.getByLabel("启用费用预留限制", { exact: true }).click(); await page.getByRole("button", { name: "保存 AI 设置", exact: true }).click(); await waitForBridge({ type: "ai_settings" }, reply => reply.ok && !(reply.value as { preferences: { cost?: { enabled: boolean } } }).preferences.cost?.enabled); await page.getByRole("button", { name: "保存 AI 设置", exact: true }).waitFor(); encryptedAi = await bridge({ type: "ai_settings" });
  await page.getByRole("button", { name: "文档导入", exact: true }).click();
  await page.getByRole("button", { name: "选择文档", exact: true }).waitFor();
  assert.equal(await page.getByLabel("AI 服务地址", { exact: true }).count(), 0);
  assert.equal(modelCalls, 0); await page.screenshot({ path: ".build/evidence/electron-document-workspace.png" });
  stage = "document review, recovery, grading and backup";
  const { BoundedZip } = await import(pathToFileURL(join(runtimeDirectory, "zip.js")).href), { resourceReferences } = await import(pathToFileURL(join(runtimeDirectory, "bank-references.js")).href);
  const readExportedBank = async (path: string): Promise<Omit<DocumentBankImport, "title">> => {
    const zip = await BoundedZip.open(path, { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
    try {
      const manifest = JSON.parse((await zip.read("manifest.json", 65536)).toString()); assert.equal(manifest.format, "practiq-question-bank"); assert.equal(manifest.version, 2);
      const root = JSON.parse((await zip.read("questions.json", 32 * 1024 * 1024)).toString());
      for (const [name, reference] of resourceReferences(root)) { const bytes = await zip.read(name, 25 * 1024 * 1024); assert.equal(bytes.length, reference.sizeBytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), reference.sha256); }
      for (const entry of zip.entries.values()) assert.equal(entry.externalFileAttributes >>> 16 & 0o777, 0o600); return root;
    } finally { zip.close(); }
  };
  const savedFixture = await BoundedZip.open(resolve("fixtures/service-export/partial-media-bank.zip"), { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
  let savedRoot: Record<string, unknown>, savedResources: { key: string; media: string; bytes: string }[];
  try {
    savedRoot = JSON.parse((await savedFixture.read("questions.json", 32 * 1024 * 1024)).toString()); savedResources = [];
    for (const [name, reference] of resourceReferences(savedRoot) as Map<string, { objectKey: string; mediaType: string }>) savedResources.push({ key: reference.objectKey, media: reference.mediaType, bytes: (await savedFixture.read(name, 25 * 1024 * 1024)).toString("base64") });
  } finally { savedFixture.close(); }
  const savedTask = await instance.evaluate(async (_electron, data) => {
    const { Worker } = process.getBuiltinModule("node:worker_threads");
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const get = name => import(new URL(name + ".js", workerData.base));
        const [{ AiDatabase }, { AiStorage, sourceKey }, { SqliteCheckpoints }, { SqliteStore }, { DocumentTasks }, { DocumentRuntime }, { hash }, { randomUUID }] = await Promise.all([get("ai-database"), get("ai-storage"), get("checkpoints"), get("graph-store"), get("document-tasks"), get("document-runtime"), get("assets"), import("node:crypto")]);
        const calls = new AiDatabase(workerData.directory), storage = new AiStorage(workerData.directory), checkpoints = new SqliteCheckpoints(workerData.directory), store = new SqliteStore(workerData.directory), tasks = new DocumentTasks(workerData.directory, storage, calls); let report;
        const config = { revision: randomUUID(), preferences: workerData.preferences, secrets: { modelApiKey: "SEED_ONLY", tencentSecretId: "SEED_ONLY", tencentSecretKey: "SEED_ONLY" } };
        try {
          const bytes = Buffer.from("Already saved source for a native import acceptance fixture"), sha256 = hash(bytes), source = { sourceType: "text", mediaType: "text/plain", fileName: "结果入库验证.txt", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await storage.putSource(source, bytes);
          const references = new Map(), artifacts = [];
          for (const [index, item] of workerData.resources.entries()) { const reference = await storage.putArtifact(Buffer.from(item.bytes, "base64"), sha256, "saved-resource", index, item.media); references.set(item.key, reference); artifacts.push(reference); }
          const root = structuredClone(workerData.root);
          for (const visual of root.result.visualElements) for (const key of ["imageRef", "sourceRef"]) if (visual[key]) visual[key] = references.get(visual[key].objectKey);
          for (const question of root.result.questions) if (question.audioRef) question.audioRef = references.get(question.audioRef.objectKey);
          const runtime = new DocumentRuntime(tasks, checkpoints, { prepare: async () => ({ artifacts: [] }), recognize: async () => ({ artifacts: [] }), structure: async () => ({ artifacts: [] }), assemble: async () => {
            const result = await storage.putArtifact(Buffer.from(JSON.stringify(root.result)), sha256, "result", 0, "application/json"), processing = root.processing ? await storage.putArtifact(Buffer.from(JSON.stringify(root.processing)), sha256, "processing", 0, "application/json") : null;
            return { artifacts: [...artifacts, result, ...(processing ? [processing] : [])], result, ...(processing ? { processing } : {}), status: root.status };
          } }, store);
          const receipt = tasks.create({ requestId: randomUUID(), document: source }, config); await runtime.run(receipt.threadId, config); const task = tasks.record(receipt.threadId);
          if (task.state !== "COMPLETED") throw Error("Fixture failed to finish: " + task.errorCode);
          const [{ ChunkInputs }, { readTextInputs, textUnitInput }, { UnitResults }, { AppError }] = await Promise.all([get("chunk-inputs"), get("text-inputs"), get("unit-results"), get("errors")]);
          const partialBytes = Buffer.from("1. Short answer: Saved partial question?\\nReference answer: Supplied answer"), partialSha = hash(partialBytes), partialSource = { sourceType: "text", mediaType: "text/plain", fileName: "部分结果验证.txt", sizeBytes: partialBytes.length, sha256: partialSha, objectKey: sourceKey("text", partialSha) }; await storage.putSource(partialSource, partialBytes);
          const partialRuntime = new DocumentRuntime(tasks, checkpoints, { prepare: async () => ({ artifacts: [] }), recognize: async context => {
            const textRef = await storage.putArtifact(partialBytes, partialSha, "text", 0, "text/plain"), chunks = await new ChunkInputs(storage).prepare(context, textRef);
            const recognized = { version: 1, source: partialSource, textRef, chunkManifest: chunks.manifest, ocrPageRefs: [], inputParts: [], warnings: [], truncated: false }, manifest = await storage.putArtifact(Buffer.from(JSON.stringify(recognized)), partialSha, "recognized-text", 0, "application/json");
            return { manifest, artifacts: [manifest, textRef, ...chunks.artifacts] };
          }, structure: async context => {
            const { chunks } = readTextInputs(storage, context), { identity } = textUnitInput(storage, context.task, chunks, 0);
            await new UnitResults(store, storage, context.task.id, partialSha, context.task.executionFingerprint).save(identity, { parsed: { questions: [{ id: "fragment:1:1", stem: "Saved partial question?", answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: "Supplied answer" }, sourceText: partialBytes.toString(), confidence: 1, needsReview: false }], groups: [] }, visuals: [] });
            throw new AppError("LOCAL_FILE_INVALID", "Acceptance fixture stops after saving its unit");
          }, assemble: async () => { throw Error("Partial fixture must never assemble"); } }, store);
          const partialReceipt = tasks.create({ requestId: randomUUID(), document: partialSource }, config); await partialRuntime.run(partialReceipt.threadId, config); const partial = tasks.record(partialReceipt.threadId);
          if (partial.state !== "FAILED" || partial.outputs.structure || partial.outputs.assemble) throw Error("Partial fixture did not retain its checkpoint gap");
          let generationCalls = 0;
          const [{ AnswerGenerator }, { ModelClient }, { TextDocuments }, { TencentResults }, { TencentClient }] = await Promise.all([get("answer-generation"), get("model"), get("text-documents"), get("tencent-results"), get("tencent")]);
          const documents = new TextDocuments(storage, new TencentResults(new TencentClient(calls, async () => { throw Error("Saved recognition fixtures must not contact Tencent"); }), storage));
          const generator = new AnswerGenerator(storage, new ModelClient(calls, async (_url, init) => {
            const request = JSON.parse(init.body); if (request.tools[0].name !== "GeneratedAnswer") throw Error("Unexpected generation contract"); generationCalls++;
            return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "GeneratedAnswer", arguments: JSON.stringify({ answerPayload: { correct: ["B"] }, analysis: "AI 生成的参考解析，需人工核对" }) }], usage: { input_tokens: 10, output_tokens: 5 } }));
          }));
          async function completedFixture(fileName, question, documentRole, generateAnswers = false, withProcessing = false) {
            const bytes = Buffer.from(question.sourceText), sha256 = hash(bytes), document = { sourceType: "text", mediaType: "text/plain", fileName, sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await storage.putSource(document, bytes);
            const runtime = new DocumentRuntime(tasks, checkpoints, { prepare: context => documents.prepare(context), recognize: async context => {
              const textRef = await storage.putArtifact(bytes, sha256, "text", 0, "text/plain"), chunks = await new ChunkInputs(storage).prepare(context, textRef), manifest = await storage.putArtifact(Buffer.from(JSON.stringify({ version: 1, source: document, textRef, chunkManifest: chunks.manifest, ocrPageRefs: [], inputParts: [], warnings: [], truncated: false })), sha256, "recognized-text", 0, "application/json"); return { manifest, artifacts: [manifest, textRef, ...chunks.artifacts] };
            }, structure: async context => {
              const { chunks } = readTextInputs(storage, context), { identity } = textUnitInput(storage, context.task, chunks, 0), unit = await new UnitResults(store, storage, context.task.id, sha256, context.task.executionFingerprint).save(identity, { parsed: { questions: [{ ...question, id: "fragment:1:1" }], groups: [] }, visuals: [] }); return { artifacts: [unit.resultRef] };
            }, assemble: async () => {
              const result = await storage.putArtifact(Buffer.from(JSON.stringify({ schemaVersion: 3, questions: [question], groups: [], visualElements: [], warnings: [], confidenceScore: 80, missingFields: [] })), sha256, "result", 0, "application/json");
              if (!generateAnswers && !withProcessing) return { result, artifacts: [result], status: "SUCCEEDED" };
              const processing = await storage.putArtifact(Buffer.from(JSON.stringify({ chunks: { total: 1, succeeded: 1, skipped: 0 }, visuals: { total: 0, succeeded: 0, skipped: 0 }, truncated: false, failures: [], questionSources: [{ questionId: question.id, stage: "document_parse", unitIndex: 0 }], quality: { reviewRequired: true, reviewQuestionCount: 1, issues: [] } })), sha256, "processing", 0, "application/json"); return { result, processing, artifacts: [result, processing], status: "SUCCEEDED" };
            }, answers: context => generator.generate(context) }, store);
            const receipt = tasks.create({ requestId: randomUUID(), document, documentRole, generateAnswers, failurePolicy: withProcessing ? "review" : "return_partial" }, config); await runtime.run(receipt.threadId, config); const saved = tasks.record(receipt.threadId); if (saved.state !== (withProcessing ? "WAITING_REVIEW" : "COMPLETED")) throw Error("Answer fixture failed: " + fileName + ":" + saved.failedStage + ":" + saved.errorCode);
            return { threadId: saved.id, checkpointId: saved.checkpointId, sha256 };
          }
          const binding = await completedFixture("答案关联验证.txt", { id: "q0", stem: "1. 请选择正确标签", answerMode: "choice", choiceVariant: "single", questionTypeId: "选择题", options: [{ label: "A", content: "First" }, { label: "B", content: "Second" }], answerPayload: null, sourceText: "1. 请选择正确标签\\nA. First\\nB. Second", confidence: .8, needsReview: true }, "questions");
          const answers = await completedFixture("关联答案卷.txt", { id: "q0", stem: "1. 已提供的答案", answerMode: "short_answer", questionTypeId: "答案记录", answerPayload: { text: "B" }, sourceText: "1. B", analysis: "原卷提供的解析", scoringRubric: "原卷提供的评分标准", confidence: .8, needsReview: true }, "answers");
          const generated = await completedFixture("答案生成验证.txt", { id: "q0", stem: "1. 生成参考答案", answerMode: "choice", choiceVariant: "single", questionTypeId: "选择题", options: [{ label: "A", content: "First" }, { label: "B", content: "Second" }], answerPayload: null, analysis: null, sourceText: "1. 生成参考答案\\nA. First\\nB. Second", confidence: .8, needsReview: true }, "questions", true);
          const reparseParent = await completedFixture("来源重解析验证.txt", { id: "q0", stem: "Reparse fixture?", answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: "Supplied answer" }, sourceText: "1. Short answer: Reparse fixture?\\nReference answer: Supplied answer", confidence: .9, needsReview: false }, "questions", false, true);
          if (generationCalls !== 1 || JSON.parse(storage.artifact(tasks.record(generated.threadId).outputs.assemble.result).toString()).questions[0].answerPayload !== null) throw Error("Generation must retain extraction and use one explicit call");
          report = { threadId: task.id, checkpointId: task.checkpointId, resources: artifacts.map(item => ({ sha256: item.sha256, sizeBytes: item.sizeBytes })), partial: { threadId: partial.id, checkpointId: partial.checkpointId }, binding, answers, generated, reparseParent };
        } finally { store.stop(); checkpoints.close(); tasks.close(); calls.close(); }
        parentPort.postMessage(report);
      })().catch(error => parentPort.postMessage({ fixtureError: { code: error.code, message: error.message, params: error.params } }));
    `, { eval: true, workerData: { directory: data.directory, base: data.base, root: data.root, resources: data.resources, preferences: data.preferences }, env: {} });
    try { return await new Promise<{ threadId: string; checkpointId: string; resources: { sha256: string; sizeBytes: number }[]; partial: { threadId: string; checkpointId: string }; binding: { threadId: string; checkpointId: string }; answers: { threadId: string; checkpointId: string; sha256: string }; generated: { threadId: string; checkpointId: string }; reparseParent: { threadId: string; checkpointId: string } }>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); worker.once("exit", code => { if (code) reject(new Error(`Fixture worker exited ${code}`)); }); }); }
    finally { await worker.terminate(); }
  }, { directory: practiceDirectory, base: pathToFileURL(runtimeDirectory + "/").href, root: savedRoot, resources: savedResources, preferences: (encryptedAi.value as typeof settings).preferences });
  assert.equal((savedTask as { fixtureError?: unknown }).fixtureError, undefined, JSON.stringify(savedTask));
  await page.getByRole("link", { name: "导入记录", exact: true }).click();
  await page.getByRole("button", { name: "结果入库验证.txt", exact: true }).click();
  await page.getByRole("button", { name: "导入题库", exact: true }).click();
  await page.getByText("题库已导入，可前往“我的题库”开始练习。", { exact: true }).waitFor();
  const documentBanks = (await bridge({ type: "banks" })).value as { id: string; title: string; count: number }[], documentBank = documentBanks.find(bank => bank.title === "结果入库验证")!;
  assert.equal(documentBank.count, 2);
  const importedAgain = await bridge({ type: "document_request", request: { type: "import_bank", revision: (encryptedAi.value as typeof settings).revision, value: { threadId: savedTask.threadId, checkpointId: savedTask.checkpointId, scope: "full" } } });
  assert.deepEqual(importedAgain, { ok: true, value: { type: "import_bank", value: { bankId: documentBank.id, count: 2 } } });
  assert.equal(((await bridge({ type: "banks" })).value as unknown[]).length, documentBanks.length);
  for (const reference of savedTask.resources) assert.equal(await page.evaluate(async item => { const reply = await window.practiq!.request({ type: "asset", hash: item.sha256 }); return reply.ok ? (reply.value as ArrayBuffer).byteLength : -1; }, reference), reference.sizeBytes);
  assert.equal(modelCalls, 0); await page.screenshot({ path: ".build/evidence/electron-document-bank-import.png" });
  const correctionSettingsRevision = (encryptedAi.value as typeof settings).revision;
  const fullBankZip = join(directory, "document-full.zip"); await instance.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, fullBankZip);
  await page.getByRole("button", { name: "导出题库 ZIP", exact: true }).click(); await page.getByText("题库 ZIP 已保存。", { exact: true }).waitFor();
  const fullPortable = await readExportedBank(fullBankZip); assert.equal(fullPortable.status, "PARTIAL"); assert.equal(fullPortable.result.questions.length, (savedRoot.result as { questions: unknown[] }).questions.length); assert.ok(resourceReferences(fullPortable).size > 0);
  assert.equal(((await bridge({ type: "banks" })).value as unknown[]).length, documentBanks.length);
  await instance.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" }); }); await page.getByRole("button", { name: "导出题库 ZIP", exact: true }).click(); await page.getByText("已取消保存题库 ZIP。", { exact: true }).waitFor();
  const originalDocument = await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.threadId } }); assert.equal(originalDocument.ok, true);
  await page.locator("details.question-card").first().locator("summary").first().click();
  await page.getByRole("button", { name: "对照原文与校对", exact: true }).first().click();
  await page.getByRole("button", { name: "人工校对", exact: true }).click();
  await page.getByRole("form", { name: "人工校对题目", exact: true }).getByRole("textbox").first().fill("人工修订后的材料");
  await page.getByRole("button", { name: "保存修订", exact: true }).click();
  await page.getByText("修订已保存。导入修订版会包含全部已保存修改，原始题库保留。", { exact: true }).waitFor();
  const correctionReply = await bridge({ type: "document_request", request: { type: "corrections", revision: correctionSettingsRevision, threadId: savedTask.threadId } }); assert.equal(correctionReply.ok, true);
  const correctionHistory = (correctionReply.value as { value: { edits: { requestId: string; question: { stem: string } }[] } }).value;
  assert.equal(correctionHistory.edits.length, 1); assert.equal(correctionHistory.edits[0].question.stem, "人工修订后的材料");
  const revisedBankZip = join(directory, "document-revised.zip"); await instance.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, revisedBankZip);
  await page.getByRole("button", { name: "导出修订版 ZIP", exact: true }).click(); await page.getByText("题库 ZIP 已保存。", { exact: true }).waitFor(); const revisedPortable = await readExportedBank(revisedBankZip); assert.equal(revisedPortable.result.questions[0].stem, "人工修订后的材料"); assert.ok(revisedPortable.result.warnings.some(value => value.includes("Human-corrected")));
  const revisedSnapshot = await bridge({ type: "document_request", request: { type: "bank", revision: correctionSettingsRevision, value: { threadId: savedTask.threadId, checkpointId: savedTask.checkpointId, scope: "full", revisionId: correctionHistory.edits[0].requestId } } }); assert.equal(revisedSnapshot.ok, true); assert.equal((revisedSnapshot.value as { value: { title: string } }).value.title, "结果入库验证");
  await page.getByRole("button", { name: "导入修订版题库", exact: true }).click();
  await waitForBridge({ type: "banks" }, reply => { const banks = reply.ok ? reply.value as { id: string; title: string }[] : []; return banks.length === documentBanks.length + 1 && banks.some(bank => bank.title === "结果入库验证" && bank.id !== documentBank.id); });
  const revisedBanks = (await bridge({ type: "banks" })).value as { id: string; title: string; count: number }[], revisedBank = revisedBanks.find(bank => bank.title === "结果入库验证" && bank.id !== documentBank.id); assert.ok(revisedBank, JSON.stringify(revisedBanks)); assert.equal(revisedBank.count, 2);
  const repeatedRevision = await bridge({ type: "document_request", request: { type: "import_bank", revision: correctionSettingsRevision, value: { threadId: savedTask.threadId, checkpointId: savedTask.checkpointId, scope: "full", revisionId: correctionHistory.edits[0].requestId } } });
  assert.deepEqual(repeatedRevision, { ok: true, value: { type: "import_bank", value: { bankId: revisedBank.id, count: 2 } } });
  assert.deepEqual(await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.threadId } }), originalDocument);
  const revisedQuestions = await bridge({ type: "questions_page", bank_ids: [revisedBank.id], search: "", mode: "", filter: "", limit: 20, offset: 0 }); assert.equal(revisedQuestions.ok, true, JSON.stringify(revisedQuestions)); assert.ok(JSON.stringify(revisedQuestions.value).includes("人工修订后的材料"));
  assert.equal(modelCalls, 0); await page.screenshot({ path: ".build/evidence/electron-document-corrections.png" });
  await page.getByRole("button", { name: "返回题目列表", exact: true }).click();
  const selectedBankZip = join(directory, "document-selected.zip"); await instance.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, selectedBankZip);
  await page.getByLabel("选择第 2 题", { exact: true }).check(); await page.getByRole("button", { name: "导出所选题目 ZIP", exact: true }).click(); await page.getByText("题库 ZIP 已保存。", { exact: true }).waitFor();
  const selectedPortable = await readExportedBank(selectedBankZip); assert.equal(selectedPortable.result.questions[0].stem, "人工修订后的材料"); assert.ok(selectedPortable.result.warnings.some(value => value.includes("Selected-question export"))); assert.equal(((await bridge({ type: "banks" })).value as unknown[]).length, revisedBanks.length);
  await page.getByRole("link", { name: "导入记录", exact: true }).click();
  await page.getByRole("button", { name: "答案关联验证.txt", exact: true }).click();
  const bindingBefore = await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.binding.threadId } }); assert.equal(bindingBefore.ok, true);
  const answerBefore = await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.answers.threadId } }); assert.equal(answerBefore.ok, true);
  await page.getByRole("button", { name: "关联答案卷", exact: true }).click();
  await page.getByRole("combobox", { name: /已完成的答案卷任务/ }).click();
  await page.getByRole("option", { name: "关联答案卷.txt", exact: true }).click();
  await page.getByRole("button", { name: "读取匹配建议（不调用模型）", exact: true }).click();
  await page.getByText(/题号有唯一候选，请核对/).waitFor();
  const noAssociation = await bridge({ type: "document_request", request: { type: "corrections", revision: correctionSettingsRevision, threadId: savedTask.binding.threadId } }); assert.deepEqual((noAssociation.value as { value: { edits: unknown[] } }).value.edits, []);
  await page.getByRole("button", { name: "采用此答案并进入校对 · 第 1 题", exact: true }).click();
  await page.getByRole("form", { name: "人工校对题目", exact: true }).waitFor();
  await page.getByRole("button", { name: "保存修订", exact: true }).click();
  const bound = await waitForBridge({ type: "document_request", request: { type: "corrections", revision: correctionSettingsRevision, threadId: savedTask.binding.threadId } }, reply => reply.ok && (reply.value as { value: { edits: unknown[] } }).value.edits.length === 1);
  const boundEdit = (bound.value as { value: { edits: { requestId: string; question: { answerPayload: unknown }; answerEvidence: { sourceSha256: string; sourceText: string } }[] } }).value.edits[0]; assert.deepEqual(boundEdit.question.answerPayload, { correct: ["B"] }); assert.equal(boundEdit.answerEvidence.sourceSha256, savedTask.answers.sha256); assert.equal(boundEdit.answerEvidence.sourceText, "1. B");
  await page.getByRole("button", { name: "导入修订版题库", exact: true }).click();
  await waitForBridge({ type: "banks" }, reply => reply.ok && (reply.value as { title: string }[]).some(bank => bank.title === "答案关联验证"));
  const boundBank = ((await bridge({ type: "banks" })).value as { id: string; title: string }[]).find(bank => bank.title === "答案关联验证")!;
  const boundRows = await bridge({ type: "questions_page", bank_ids: [boundBank.id], search: "", mode: "", filter: "", limit: 20, offset: 0 }); assert.equal(boundRows.ok, true); const boundRoot = (boundRows.value as { items: { id: string }[] }).items[0];
  const boundQuestion = await bridge({ type: "question_detail", id: boundRoot.id }); assert.equal(boundQuestion.ok, true); assert.deepEqual((boundQuestion.value as { question: { answerPayload: unknown } }).question.answerPayload, { correct: ["B"] });
  const boundSnapshot = await bridge({ type: "document_request", request: { type: "bank", revision: correctionSettingsRevision, value: { threadId: savedTask.binding.threadId, checkpointId: savedTask.binding.checkpointId, scope: "full", revisionId: boundEdit.requestId } } }); assert.equal(boundSnapshot.ok, true); assert.ok((boundSnapshot.value as { value: { result: { warnings: string[] } } }).value.result.warnings.some(warning => warning.includes(savedTask.answers.sha256) && warning.includes("1. B")));
  assert.deepEqual(await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.binding.threadId } }), bindingBefore); assert.deepEqual(await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.answers.threadId } }), answerBefore);
  assert.equal(modelCalls, 0); await page.screenshot({ path: ".build/evidence/electron-answer-binding.png" });
  await page.getByRole("button", { name: "返回题目列表", exact: true }).click();
  await page.getByRole("link", { name: "导入记录", exact: true }).click();
  await page.getByRole("button", { name: "部分结果验证.txt", exact: true }).click();
  await page.getByRole("button", { name: "导入题库", exact: true }).click();
  await page.getByText("题库已导入，可前往“我的题库”开始练习。", { exact: true }).waitFor();
  const partialBanks = (await bridge({ type: "banks" })).value as { title: string; count: number }[]; assert.equal(partialBanks.find(bank => bank.title === "部分结果验证")?.count, 1);
  const partialHead = await bridge({ type: "document_request", request: { type: "head", revision: (encryptedAi.value as typeof settings).revision, threadId: savedTask.partial.threadId } });
  assert.equal(partialHead.ok, true); assert.deepEqual({ state: (partialHead.value as { value: { state: string } }).value.state, checkpointId: (partialHead.value as { value: { checkpointId: string } }).value.checkpointId }, { state: "FAILED", checkpointId: savedTask.partial.checkpointId });
  assert.equal(modelCalls, 0); await page.screenshot({ path: ".build/evidence/electron-completed-unit-import.png" });
  const partialBankZip = join(directory, "document-partial.zip"); await instance.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, partialBankZip);
  await page.getByRole("button", { name: "导出题库 ZIP", exact: true }).click(); await page.getByText("题库 ZIP 已保存。", { exact: true }).waitFor();
  const partialPortable = await readExportedBank(partialBankZip); assert.equal(partialPortable.status, "PARTIAL"); assert.equal(partialPortable.result.questions.length, 1); assert.equal(partialPortable.result.questions[0].stem, "Saved partial question?"); assert.equal(((await bridge({ type: "banks" })).value as unknown[]).length, partialBanks.length); assert.equal(modelCalls, 0); assert.equal(documentModelCalls, 0);
  await page.screenshot({ path: ".build/evidence/electron-portable-bank-export.png" });
  await page.getByRole("link", { name: "导入记录", exact: true }).click();
  await page.getByRole("button", { name: "答案生成验证.txt", exact: true }).click();
  const generatedBefore = await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.generated.threadId } }); assert.equal(generatedBefore.ok, true);
  assert.equal((generatedBefore.value as { value: { usage: unknown[] } }).value.usage.length, 1);
  await page.getByRole("button", { name: "导入题库", exact: true }).click();
  await page.getByText("题库已导入，可前往“我的题库”开始练习。", { exact: true }).waitFor();
  const generatedBank = ((await bridge({ type: "banks" })).value as { id: string; title: string }[]).find(bank => bank.title === "答案生成验证")!; assert.ok(generatedBank);
  const generatedRows = await bridge({ type: "questions_page", bank_ids: [generatedBank.id], search: "", mode: "", filter: "", limit: 20, offset: 0 }); assert.equal(generatedRows.ok, true);
  const generatedQuestionId = (generatedRows.value as { items: { id: string }[] }).items[0].id;
  const generatedQuestion = await bridge({ type: "question_detail", id: generatedQuestionId }); assert.equal(generatedQuestion.ok, true);
  assert.deepEqual((generatedQuestion.value as { question: { answerPayload: unknown } }).question.answerPayload, { correct: ["B"] });
  assert.equal((generatedQuestion.value as { question: { needsReview: boolean } }).question.needsReview, true);
  const generatedSnapshot = await bridge({ type: "document_request", request: { type: "bank", revision: correctionSettingsRevision, value: { threadId: savedTask.generated.threadId, checkpointId: savedTask.generated.checkpointId, scope: "full" } } }); assert.equal(generatedSnapshot.ok, true); assert.ok(JSON.stringify(generatedSnapshot.value).includes("AI 生成答案与解析（需人工核对）"));
  assert.deepEqual(await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.generated.threadId } }), generatedBefore);
  assert.equal(modelCalls, 0); await page.screenshot({ path: ".build/evidence/electron-answer-generation.png" });
  await page.getByRole("link", { name: "导入记录", exact: true }).click();
  await page.getByRole("button", { name: "来源重解析验证.txt", exact: true }).click();
  const reviewRequest = { type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.reparseParent.threadId } }, reviewBefore = await bridge(reviewRequest);
  assert.equal(reviewBefore.ok, true); const reviewed = (reviewBefore.value as { value: { state: string; status: string; checkpointId: string; result: unknown; processing: unknown; usage: unknown[] } }).value;
  assert.equal(reviewed.state, "WAITING_REVIEW"); assert.equal(reviewed.status, "SUCCEEDED"); assert.equal(documentModelCalls, 0); assert.equal(modelCalls, 0);
  await page.getByRole("button", { name: "接受部分结果", exact: true }).waitFor(); await page.screenshot({ path: ".build/evidence/electron-quality-review.png" });
  await page.getByRole("button", { name: "接受部分结果", exact: true }).click(); await waitForBridge(reviewRequest, reply => reply.ok && (reply.value as { value: { state: string } }).value.state === "COMPLETED");
  const reparseBefore = await bridge(reviewRequest); assert.equal(reparseBefore.ok, true); const accepted = (reparseBefore.value as { value: typeof reviewed }).value;
  for (const field of ["status", "checkpointId", "result", "processing", "usage"] as const) assert.deepEqual(accepted[field], reviewed[field]); assert.equal(documentModelCalls, 0); assert.equal(modelCalls, 0);
  await page.getByRole("button", { name: "勾选本页", exact: true }).click();
  await page.getByRole("button", { name: "重新解析所选题目的来源", exact: true }).click();
  await page.getByText("所选来源单元已创建新解析任务，原任务保留。", { exact: true }).waitFor();
  const reparseListRequest = { type: "document_request", request: { type: "list", revision: correctionSettingsRevision, offset: 0, limit: 100, state: "" } };
  await waitForBridge(reparseListRequest, reply => reply.ok && (reply.value as { value: { items: { threadId: string; fileName: string }[] } }).value.items.some(item => item.fileName === "来源重解析验证.txt" && item.threadId !== savedTask.reparseParent.threadId));
  const reparseChild = ((await bridge(reparseListRequest)).value as { value: { items: { threadId: string; fileName: string }[] } }).value.items.find(item => item.fileName === "来源重解析验证.txt" && item.threadId !== savedTask.reparseParent.threadId)!;
  const reparseDetailRequest = { type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: reparseChild.threadId } };
  await waitForBridge(reparseDetailRequest, reply => reply.ok && (reply.value as { value: { state: string } }).value.state === "WAITING_REVIEW");
  await page.getByRole("button", { name: "接受部分结果", exact: true }).click(); await waitForBridge(reparseDetailRequest, reply => reply.ok && (reply.value as { value: { state: string } }).value.state === "COMPLETED");
  const reparseDetail = ((await bridge(reparseDetailRequest)).value as { value: { state: string; modelBudget: { limit: number; reserved: number | null }; parentThreadId: string; parserJobs: unknown[]; usage: unknown[]; result: { warnings: string[] }; processing: { questionSources: { unitIndex: number }[] } } }).value;
  assert.equal(reparseDetail.parentThreadId, savedTask.reparseParent.threadId); assert.deepEqual(reparseDetail.parserJobs, []); assert.equal(reparseDetail.usage.length, 1); assert.equal(documentModelCalls, 1); assert.deepEqual(reparseDetail.processing.questionSources.map(source => source.unitIndex), [0]);
  assert.ok(reparseDetail.result.warnings.some(warning => warning.includes("reuses verified Tencent evidence")));
  assert.deepEqual(await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.reparseParent.threadId } }), reparseBefore);
  await page.getByRole("button", { name: "导入题库", exact: true }).click();
  await page.getByText("题库已导入，可前往“我的题库”开始练习。", { exact: true }).waitFor();
  assert.equal(documentModelCalls, 1); await page.screenshot({ path: ".build/evidence/electron-selected-reparse.png" });
  const sourceStatusRequest = { type: "document_request", request: { type: "source_status", revision: correctionSettingsRevision, threadId: reparseChild.threadId } }, healthySource = await bridge(sourceStatusRequest); assert.equal(healthySource.ok, true);
  const repairDocument = (healthySource.value as { value: { document: { objectKey: string }; status: string } }).value; assert.equal(repairDocument.status, "verified");
  const storedSource = join(practiceDirectory, "ai-storage", repairDocument.document.objectKey), replacementSource = join(directory, "original-source.txt"), originalSource = await readFile(storedSource); await writeFile(replacementSource, originalSource); await writeFile(storedSource, "native smoke damaged source");
  await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, replacementSource);
  await page.locator("details.task-secondary-actions > summary").click(); await page.getByRole("button", { name: "校验原文", exact: true }).click(); await page.getByText("保存的原文校验失败。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "选择原文件并修复", exact: true }).click(); await page.getByText("原文已修复，损坏副本及修复清单已保留。", { exact: true }).waitFor();
  assert.deepEqual(await readFile(storedSource), originalSource); assert.equal((await bridge(sourceStatusRequest)).ok, true);
  const sourceRepairStore = new DatabaseSync(join(practiceDirectory, "ai-store-v1.sqlite"), { readOnly: true });
  try {
    const repairRows = sourceRepairStore.prepare("SELECT value FROM store_items WHERE namespace='[\"source_repairs\"]'").all(); assert.equal(repairRows.length, 1);
    const repairRecord = JSON.parse(String(repairRows[0].value)), quarantinePath = join(practiceDirectory, "ai-storage", ".quarantine", "source-repair", repairRecord.quarantineId);
    assert.equal(repairRecord.result.status, "repaired"); assert.equal(await readFile(join(quarantinePath, "original"), "utf8"), "native smoke damaged source"); assert.equal(JSON.parse(await readFile(join(quarantinePath, "manifest.json"), "utf8")).completed, true);
  } finally { sourceRepairStore.close(); }
  assert.equal(documentModelCalls, 1); assert.equal(modelCalls, 0); assert.deepEqual(((await bridge(reparseDetailRequest)).value as { value: unknown }).value, reparseDetail);
  await page.screenshot({ path: ".build/evidence/electron-source-repair.png" });
  const diagnosticTasks = new DatabaseSync(join(practiceDirectory, "document-tasks-v1.sqlite"), { readOnly: true });
  let diagnosticRecord: string;
  try { diagnosticRecord = String(diagnosticTasks.prepare("SELECT record FROM document_tasks WHERE id=?").get(reparseChild.threadId)!.record); } finally { diagnosticTasks.close(); }
  const diagnosticResult = JSON.parse(diagnosticRecord).outputs.assemble.result, diagnosticPath = join(practiceDirectory, "ai-storage", diagnosticResult.objectKey), diagnosticOriginal = await readFile(diagnosticPath);
  await writeFile(diagnosticPath, "native smoke damaged saved result"); await page.getByRole("button", { name: "刷新任务详情", exact: true }).click();
  await page.getByText("保存的任务结果或检查点无法读取，继续、重试和导出已停用。原文件、调用记录和用量记录仍保留。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "导入题库", exact: true }).isEnabled(), false); assert.equal(await page.getByRole("button", { name: "导出题库 ZIP", exact: true }).isEnabled(), false);
  assert.equal((await bridge(reparseDetailRequest)).ok, true); assert.equal(((await bridge(reparseDetailRequest)).value as { value: { state: string } }).value.state, "FAILED"); assert.equal(documentModelCalls, 1); assert.equal(modelCalls, 0);
  await page.screenshot({ path: ".build/evidence/electron-unreadable-evidence.png" });
  await writeFile(diagnosticPath, diagnosticOriginal); await page.getByRole("button", { name: "刷新任务详情", exact: true }).click(); await page.getByRole("button", { name: "导入题库", exact: true }).waitFor();
  await waitForBridge(reparseDetailRequest, reply => reply.ok && (reply.value as { value: { state: string } }).value.state === "COMPLETED");
  assert.deepEqual(((await bridge(reparseDetailRequest)).value as { value: unknown }).value, reparseDetail);
  const restoredTasks = new DatabaseSync(join(practiceDirectory, "document-tasks-v1.sqlite"), { readOnly: true });
  try { assert.equal(String(restoredTasks.prepare("SELECT record FROM document_tasks WHERE id=?").get(reparseChild.threadId)!.record), diagnosticRecord); } finally { restoredTasks.close(); }
  const accountingStore = new DatabaseSync(join(practiceDirectory, "ai-store-v1.sqlite")), allowanceNamespace = JSON.stringify(["document_tasks", reparseChild.threadId, "call_allowances"]);
  let allowanceValue: string;
  try { allowanceValue = String(accountingStore.prepare("SELECT value FROM store_items WHERE namespace=? AND key='ledger'").get(allowanceNamespace)!.value); accountingStore.prepare("UPDATE store_items SET value='{}' WHERE namespace=? AND key='ledger'").run(allowanceNamespace); } finally { accountingStore.close(); }
  try {
    await page.getByRole("button", { name: "刷新任务详情", exact: true }).click(); await page.getByText("保存的任务结果或检查点无法读取，继续、重试和导出已停用。原文件、调用记录和用量记录仍保留。", { exact: true }).waitFor();
    const usageSummary = page.getByText("模型用量与任务诊断", { exact: true }); if (!(await usageSummary.evaluate(element => element.parentElement!.hasAttribute("open")))) await usageSummary.click();
    await page.getByText(`调用预算：预留数未知；任务上限 ${reparseDetail.modelBudget.limit} 次。`, { exact: true }).waitFor(); await page.getByText("部分调用或额度记录无法验证，实际总用量可能未知。继续和重试已停用，原始记录保留。", { exact: true }).waitFor();
    const broken = ((await bridge(reparseDetailRequest)).value as { value: typeof reparseDetail }).value; assert.equal(broken.modelBudget.reserved, null); assert.equal(broken.state, "FAILED"); assert.deepEqual(broken.usage, reparseDetail.usage); assert.equal(documentModelCalls, 1); assert.equal(modelCalls, 0);
    assert.equal(await page.getByRole("button", { name: "导出题库 ZIP", exact: true }).isEnabled(), false); await page.getByText(`调用预算：预留数未知；任务上限 ${reparseDetail.modelBudget.limit} 次。`, { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: ".build/evidence/electron-unreadable-accounting.png" });
  } finally { const restore = new DatabaseSync(join(practiceDirectory, "ai-store-v1.sqlite")); try { restore.prepare("UPDATE store_items SET value=? WHERE namespace=? AND key='ledger'").run(allowanceValue, allowanceNamespace); } finally { restore.close(); } }
  await page.getByRole("button", { name: "刷新任务详情", exact: true }).click(); await waitForBridge(reparseDetailRequest, reply => reply.ok && (reply.value as { value: { state: string } }).value.state === "COMPLETED"); assert.deepEqual(((await bridge(reparseDetailRequest)).value as { value: unknown }).value, reparseDetail); assert.equal(documentModelCalls, 1); assert.equal(modelCalls, 0);
  await page.getByRole("link", { name: "导入记录", exact: true }).click(); await page.getByRole("button", { name: "部分结果验证.txt", exact: true }).click();
  const deleteSourceReply = await bridge({ type: "document_request", request: { type: "source_status", revision: correctionSettingsRevision, threadId: savedTask.partial.threadId } }); assert.equal(deleteSourceReply.ok, true);
  const deleteSource = (deleteSourceReply.value as { value: { document: { objectKey: string } } }).value.document, retainedSource = await readFile(join(practiceDirectory, "ai-storage", deleteSource.objectKey));
  await page.locator("details.task-secondary-actions > summary").click(); await page.getByRole("button", { name: "删除任务", exact: true }).click();
  const deletePrompt = page.getByRole("group", { name: "删除任务确认", exact: true }); await deletePrompt.getByRole("button", { name: "确认删除", exact: true }).click(); await page.getByText("任务已删除。", { exact: true }).waitFor();
  assert.equal((await bridge({ type: "document_request", request: { type: "detail", revision: correctionSettingsRevision, threadId: savedTask.partial.threadId } })).error?.code, "TASK_NOT_FOUND");
  assert.deepEqual(await bridge({ type: "document_request", request: { type: "delete", revision: correctionSettingsRevision, threadId: savedTask.partial.threadId } }), { ok: true, value: { type: "delete", value: { threadId: savedTask.partial.threadId, deleted: true } } });
  assert.equal(((await bridge({ type: "banks" })).value as { title: string; count: number }[]).find(bank => bank.title === "部分结果验证")?.count, 1); assert.deepEqual(await readFile(join(practiceDirectory, "ai-storage", deleteSource.objectKey)), retainedSource);
  const seedPagination = (names: string[], deleting = false, expired = false) => instance.evaluate(async (_electron, data) => {
    const { Worker } = process.getBuiltinModule("node:worker_threads") as typeof import("node:worker_threads");
    const worker = new Worker(`
      const { parentPort, workerData: data } = require('node:worker_threads');
      (async () => {
        const { AiDatabase } = await import(data.base+'ai-database.js'), { SqliteCheckpoints } = await import(data.base+'checkpoints.js'), { DocumentApi } = await import(data.base+'document-api.js'), { ModelClient } = await import(data.base+'model.js'), { TencentClient } = await import(data.base+'tencent.js');
        const calls=new AiDatabase(data.directory), checkpoints=new SqliteCheckpoints(data.directory), http=async()=>{throw Error('No provider calls during pagination fixture')}, api=new DocumentApi(data.directory,calls,checkpoints,new ModelClient(calls,http),new TencentClient(calls,http));
        const config={ revision:crypto.randomUUID(), preferences:data.preferences, secrets:{ modelApiKey:'TEST_ONLY', tencentSecretId:'TEST_ONLY', tencentSecretKey:'TEST_ONLY' } };
        try { for (const fileName of data.names) { const receipt=api.tasks.create({requestId:crypto.randomUUID(),document:{...data.document,fileName}},config); await api.runtime.initialize(receipt.threadId); api.tasks.stop(receipt.threadId,receipt.runId,'DOCUMENT_PARSE_FAILED'); if(data.expired) api.tasks.update(receipt.threadId,receipt.runId,record=>{record.createdAt=0;}); if(data.deleting) api.tasks.beginDelete(receipt.threadId); } }
        finally { if(data.expired) await api.store.put(['document_tasks',crypto.randomUUID(),'units'],'orphan',{saved:true}); await api.close(); checkpoints.close(); calls.close(); }
        parentPort.postMessage({ready:true});
      })().catch(error=>parentPort.postMessage({error:error.message}));
    `, { eval: true, env: {}, workerData: data });
    try { await new Promise<void>((resolve, reject) => { worker.once("message", message => message.error ? reject(Error(message.error)) : resolve()); worker.once("error", reject); worker.once("exit", code => { if (code) reject(Error(`Pagination fixture exited ${code}`)); }); }); }
    finally { await worker.terminate(); }
  }, { names, deleting, expired, directory: practiceDirectory, base: pathToFileURL(runtimeDirectory + "/").href, document: repairDocument.document, preferences: (encryptedAi.value as typeof settings).preferences });
  await seedPagination(["删除恢复验证.txt"], true); await page.getByRole("button", { name: "刷新任务列表", exact: true }).click();
  assert.equal(await page.getByRole("region", { name: "未确认的任务删除", exact: true }).count(), 0);
  await page.getByRole("button", { name: "删除已过期任务 删除恢复验证.txt", exact: true }).click(); await page.getByRole("group", { name: "删除任务确认", exact: true }).getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByText("任务已删除。", { exact: true }).waitFor(); await page.getByRole("button", { name: "删除已过期任务 删除恢复验证.txt", exact: true }).waitFor({ state: "hidden" });
  await seedPagination(Array.from({ length: 25 }, (_, index) => `分页验证${String(index + 1).padStart(2, "0")}.txt`));
  await page.getByRole("button", { name: "刷新任务列表", exact: true }).click(); await page.getByRole("button", { name: /^分页验证/ }).first().waitFor();
  const firstPageNames = await page.getByRole("button", { name: /^分页验证/ }).allTextContents(); assert.equal(firstPageNames.length, 20);
  await seedPagination(["新增分页验证.txt"]); await page.getByRole("button", { name: "下一页任务", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].filter(button => button.textContent?.startsWith("分页验证")).length === 5);
  const secondPageNames = await page.getByRole("button", { name: /^分页验证/ }).allTextContents(); assert.equal(secondPageNames.length, 5); assert.equal(firstPageNames.some(name => secondPageNames.includes(name)), false); assert.equal(documentModelCalls, 1); assert.equal(modelCalls, 0);
  assert.equal(await page.getByRole("button", { name: "上一页任务", exact: true }).isEnabled(), true); assert.equal(await page.getByRole("button", { name: "下一页任务", exact: true }).isEnabled(), false);
  await page.screenshot({ path: ".build/evidence/electron-task-lifecycle.png" });
  await seedPagination(["过期清理验证.txt"], false, true);
  const maintenanceCallsDb = new DatabaseSync(join(practiceDirectory, "ai.sqlite"), { readOnly: true });
  let maintenanceCalls;
  try { maintenanceCalls = maintenanceCallsDb.prepare("SELECT * FROM ai_calls ORDER BY id").all(); } finally { maintenanceCallsDb.close(); }
  const maintenanceBanks = (await bridge({ type: "banks" })).value;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "AI 任务清理", exact: true }).waitFor(); await page.getByRole("button", { name: "检查可清理任务", exact: true }).click();
  await page.getByText("过期清理验证.txt · 已过期任务", { exact: true }).waitFor(); await page.screenshot({ path: ".build/evidence/electron-task-maintenance-preview.png" });
  await page.getByRole("button", { name: "确认清理本批任务状态", exact: true }).click(); await page.getByText("已清理 2 项任务状态。原文、题库、练习数据和调用记录均保留。", { exact: true }).waitFor();
  const maintainedCalls = new DatabaseSync(join(practiceDirectory, "ai.sqlite"), { readOnly: true });
  try { assert.deepEqual(maintainedCalls.prepare("SELECT * FROM ai_calls ORDER BY id").all(), maintenanceCalls); } finally { maintainedCalls.close(); }
  assert.deepEqual((await bridge({ type: "banks" })).value, maintenanceBanks); assert.equal(documentModelCalls, 1); assert.equal(modelCalls, 0); await page.screenshot({ path: ".build/evidence/electron-task-maintenance.png" });
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "我的题库", exact: true }).click();
  await page.getByText("结果入库验证", { exact: true }).first().waitFor();
  const gradeBank = await bridge({ type: "save_bank", id: null, title: "评分验证", description: "内置 AI worker" }); assert.equal(gradeBank.ok, true);
  assert.equal((await bridge({ type: "save_question_tree", bank_id: gradeBank.value, root_id: null, questions: [{ id: "subjective-smoke", stem: "Electron 主观评分验证", questionTypeId: "简答题", answerMode: "short_answer", answerPayload: { text: "固定评分依据" }, scoringRubric: "固定评分依据", sourceScore: 5, sourceText: "原始内容", needsReview: false }] })).ok, true);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const gradingCard = page.locator('[data-slot="card"]').filter({ has: page.getByText("评分验证", { exact: true }) });
  await gradingCard.getByRole("button", { name: "开始练习", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "立即开始", exact: true }).click();
  await page.getByLabel("作答内容", { exact: true }).fill("我的评分作答"); await page.getByRole("button", { name: /提交答案/ }).click();
  assert.equal(modelCalls, 0);
  await page.getByRole("button", { name: /^AI 评分\/继续/ }).click();
  await page.getByText(/当前题：3 \/ 5 分 · AI 评分/).waitFor(); await page.getByText("评分引用验证通过", { exact: true }).waitFor(); assert.equal(modelCalls, 1);
  await page.screenshot({ path: ".build/evidence/electron-subjective-grade.png" });
  await page.getByRole("button", { name: "重新评分当前题", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click(); assert.equal(modelCalls, 1);
  await page.getByRole("button", { name: "重新评分当前题", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认重新评分", exact: true }).click();
  await page.getByText("明确重新评分验证通过", { exact: true }).waitFor(); assert.equal(modelCalls, 2);
  await page.getByRole("button", { name: "结束练习", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "提交草稿并结束", exact: true }).click();
  await page.getByRole("heading", { name: "练习回顾", exact: true }).waitFor();
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "我的题库", exact: true }).click();
  assert.equal((await bridge({ type: "_preview_bank_zip", path: resolve("fixtures/all-types.zip") })).error?.code, "LOCAL_FILTER_INVALID");
  assert.equal((await bridge({ type: "pick_import", path: resolve("fixtures/all-types.zip") })).error?.code, "LOCAL_FILTER_INVALID");
  const packagePath = resolve("fixtures/all-types.zip"), exportedPath = join(directory, "exported.zip");
  await instance.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected.source] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected.target });
  }, { source: packagePath, target: exportedPath });
  const preview = await bridge({ type: "pick_import" }); assert.equal(preview.ok, true);
  assert.equal(JSON.stringify(preview).includes(packagePath), false);
  const pending = preview.value as { ticket: string; title: string; count: number }; assert.equal(pending.count, 20);
  const imported = await bridge({ type: "import", ticket: pending.ticket, bank_id: null, title: pending.title }); assert.equal(imported.ok, true);
  const bank = imported.value as { bankId: string; count: number }; assert.equal(bank.count, 20);
  assert.deepEqual(await bridge({ type: "export_bank", bank_id: bank.bankId }), { ok: true, value: { path: exportedPath } });
  await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, exportedPath);
  const roundtrip = await bridge({ type: "pick_import" }); assert.equal(roundtrip.ok, true); assert.equal((roundtrip.value as { count: number }).count, 20);
  await instance.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.deepEqual(await bridge({ type: "pick_import" }), { ok: true, value: null });
  const exampleBank = await bridge({ type: "add_example_bank" }); assert.equal(exampleBank.ok, true);
  const exampleListening = await bridge({ type: "questions_page", bank_ids: [(exampleBank.value as { bankId: string }).bankId], search: "", mode: "listening", filter: "", limit: 20, offset: 0 }); assert.equal(exampleListening.ok, true);
  const exampleDetail = await bridge({ type: "question_detail", id: (exampleListening.value as { items: { id: string }[] }).items[0].id }); assert.equal(exampleDetail.ok, true);
  assert.equal((exampleDetail.value as { question: { audioRef: unknown } }).question.audioRef, null, "New example banks must not store recordings");
  await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, exportedPath);
  const beforeImport = (await bridge({ type: "banks" })).value as unknown[];
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "导入与恢复", exact: true }).click();
  await page.getByRole("menuitem", { name: "导入题库 ZIP", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "导入题库", exact: true });
  await importDialog.getByText(/共 20 题/).waitFor();
  await page.screenshot({ path: ".build/evidence/electron-import-preview.png" });
  await importDialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await importDialog.waitFor({ state: "hidden" });
  assert.equal(((await bridge({ type: "banks" })).value as unknown[]).length, beforeImport.length + 1);
  const backupPath = join(directory, "study-backup.zip");
  await instance.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, backupPath);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  await page.getByText(/备份已保存：/).waitFor();
  const extra = await bridge({ type: "save_bank", id: null, title: "Restore 删除验证", description: "只存在于恢复之前" }); assert.equal(extra.ok, true);
  await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, backupPath);
  await page.getByRole("button", { name: "导入与恢复", exact: true }).click();
  await page.getByRole("menuitem", { name: "恢复学习数据备份", exact: true }).click();
  const restoreDialog = page.getByRole("alertdialog");
  await restoreDialog.getByText("用备份替换当前数据？", { exact: true }).waitFor();
  await restoreDialog.getByRole("button", { name: "恢复备份", exact: true }).click();
  await page.getByText(/恢复完成。原数据副本：/).waitFor();
  const restoredBanks = (await bridge({ type: "banks" })).value as { id: string }[];
  assert.equal(restoredBanks.some(bank => bank.id === extra.value), false); assert.equal(restoredBanks.length, beforeImport.length + 1);
  assert.ok(restoredBanks.some(bank => bank.id === generatedBank.id));
  const restoredGenerated = await bridge({ type: "question_detail", id: generatedQuestionId }); assert.equal(restoredGenerated.ok, true);
  assert.deepEqual((restoredGenerated.value as { question: unknown }).question, (generatedQuestion.value as { question: unknown }).question);
  const history = await bridge({ type: "sessions_page", limit: 10, offset: 0 }); assert.equal(history.ok, true); assert.equal((history.value as { items: unknown[] }).items.length, 2);
  assert.equal((await bridge({ type: "restore", path: backupPath })).error?.code, "LOCAL_FILTER_INVALID");
  await page.screenshot({ path: ".build/evidence/electron-restored.png" });
  stage = "legacy listening playback";
  const listening = await bridge({ type: "questions_page", bank_ids: [bank.bankId], search: "", mode: "listening", filter: "", limit: 20, offset: 0 }); assert.equal(listening.ok, true);
  const listeningRoot = (listening.value as { items: { id: string }[] }).items[0].id;
  const listeningPaper = await bridge({ type: "preview_paper", request: { bank_ids: [bank.bankId], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: [listeningRoot], random: false, total_cents: 0 } }); assert.equal(listeningPaper.ok, true);
  const selectedListening = listeningPaper.value as { questionIds: string[]; scores: number[]; digest: string };
  const listeningSession = await bridge({ type: "start_paper", paper: { question_ids: selectedListening.questionIds, scores: selectedListening.scores, digest: selectedListening.digest, kind: "practice", minutes: null, total_cents: 0 } }); assert.equal(listeningSession.ok, true);
  const listeningSessionId = (listeningSession.value as { id: string }).id;
  const playback = await bridge({ type: "listening_playback", id: listeningSessionId, question_id: listeningRoot, action: "start" }); assert.equal(playback.ok, true); assert.equal((playback.value as { used: number }).used, 1);
  const listeningProgress = await bridge({ type: "listening_playback", id: listeningSessionId, question_id: listeningRoot, action: "progress", position: .1 }); assert.equal(listeningProgress.ok, true);
  stage = "listening QR and address-only playback";
  const beforeListeningFiles = (await readdir(join(practiceDirectory, "assets"))).sort();
  await instance.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, resolve("fixtures/listening-qr.png"));
  const qr = await bridge({ type: "pick_audio_qr" }); assert.equal(qr.ok, true); assert.deepEqual(qr.value, [{ url: "https://example.com/listening.wav", label: "" }]);
  await instance.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.equal((await bridge({ type: "pick_audio_qr" })).value, null);
  assert.equal((await bridge({ type: "load_listening_audio", url: "http://127.0.0.1/private" })).error?.code, "LOCAL_AUDIO_URL_INVALID");
  const addressBank = await bridge({ type: "save_bank", id: null, title: "链接听力", description: "仅保存播放地址" }); assert.equal(addressBank.ok, true);
  const addressRoot = randomUUID(), addressChild = randomUUID(), playbackAddress = "https://example.com/listening.wav";
  const savedAddress = await bridge({ type: "save_question_tree", bank_id: addressBank.value, root_id: null, questions: [
    { id: addressRoot, stem: "链接听力验证", answerMode: "listening", questionKind: "listening", contentBlocks: [{ partType: "text", role: "listening_audio_url", textValue: playbackAddress }], needsReview: false },
    { id: addressChild, parentId: addressRoot, stem: "Choose", answerMode: "choice", choiceVariant: "single", options: [{ label: "A", content: "One" }, { label: "B", content: "Two" }], answerPayload: { correct: ["A"] }, needsReview: false },
  ] }); assert.equal(savedAddress.ok, true);
  await instance.evaluate((_electron, value) => {
    const { ListeningWeb } = process.getBuiltinModule("node:module").createRequire(value.module)(value.module), original = ListeningWeb.prototype.fetch;
    const state = { loads: 0 }; Reflect.set(globalThis, "practiqListeningSmoke", state);
    ListeningWeb.prototype.fetch = async function(raw: unknown, mode: "links" | "audio") {
      if (raw !== value.url || mode !== "audio") return original.call(this, raw, mode);
      state.loads++; const bytes = process.getBuiltinModule("node:fs").readFileSync(value.audio);
      return { bytes: Uint8Array.from(bytes).buffer, mediaType: "audio/wav" };
    };
  }, { module: join(runtimeDirectory, "listening-web.js"), url: playbackAddress, audio: resolve("fixtures/resources/audio/chimes.wav") });
  const addressPaper = await bridge({ type: "preview_paper", request: { bank_ids: [addressBank.value], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: [addressRoot], random: false, total_cents: 0 } }); assert.equal(addressPaper.ok, true);
  const selectedAddress = addressPaper.value as { questionIds: string[]; scores: number[]; digest: string };
  const addressSession = await bridge({ type: "start_paper", paper: { question_ids: selectedAddress.questionIds, scores: selectedAddress.scores, digest: selectedAddress.digest, kind: "practice", minutes: null, total_cents: 0 } }); assert.equal(addressSession.ok, true);
  await page.getByRole("button", { name: "练习记录", exact: true }).click();
  await page.locator("[data-slot='card']").filter({ has: page.getByRole("heading", { name: /链接听力/ }) }).getByRole("button", { name: "继续练习", exact: true }).click();
  const addressPlayer = page.getByRole("region", { name: "听力播放器" }); await addressPlayer.waitFor();
  assert.equal(await instance.evaluate(() => Reflect.get(globalThis, "practiqListeningSmoke").loads), 0, "Passive practice must not load remote audio");
  await addressPlayer.locator("audio").evaluate(audio => { (audio as HTMLAudioElement).muted = true; });
  await addressPlayer.getByRole("button", { name: "播放听力", exact: true }).click();
  await addressPlayer.getByRole("button", { name: "暂停播放", exact: true }).waitFor();
  assert.equal(await instance.evaluate(() => Reflect.get(globalThis, "practiqListeningSmoke").loads), 1);
  assert.ok(await addressPlayer.locator("audio").evaluate(audio => (audio as HTMLAudioElement).currentSrc.startsWith("blob:") && (audio as HTMLAudioElement).duration > 0));
  await addressPlayer.getByRole("button", { name: "暂停播放", exact: true }).click();
  assert.deepEqual((await readdir(join(practiceDirectory, "assets"))).sort(), beforeListeningFiles, "QR and URL playback must not persist recordings");
  await addressPlayer.scrollIntoViewIfNeeded();
  await addressPlayer.screenshot({ path: ".build/evidence/electron-listening-address.png" });
  const shutdownReceipt = join(directory, "closed-workers.txt");
  stage = "graceful worker shutdown";
  await instance.evaluate(async (_electron, value) => {
    const { RpcWorker } = process.getBuiltinModule("node:module").createRequire(value.moduleUrl)(value.moduleUrl), original = RpcWorker.prototype.close;
    RpcWorker.prototype.close = async function(this: { constructor: { name: string } }) { const fs = process.getBuiltinModule("node:fs"); fs.appendFileSync(value.receipt, `start:${this.constructor.name}\n`); await original.call(this); await new Promise(resolve => setTimeout(resolve, 100)); fs.appendFileSync(value.receipt, `closed:${this.constructor.name}\n`); };
  }, { moduleUrl: join(runtimeDirectory, "rpc-worker.js"), receipt: shutdownReceipt });
  const closed = page.waitForEvent("close");
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await instance.close();
  assert.deepEqual((await readFile(shutdownReceipt, "utf8")).trim().split("\n"), ["start:AiClient", "closed:AiClient", "start:DatabaseClient", "closed:DatabaseClient"], "Keep SQLite available until AI results and both workers drain");
  assert.equal(modelCalls, 2);
  assert.deepEqual(unexpectedHttpApis, []);
  await writeFile(receipt, JSON.stringify({ checkedAt: new Date().toISOString(), ...installation, passed: true, stage: "completed", systemOnlyPath: Boolean(executable), runtimeDirectory, gracefulWorkerShutdown: true, directGradingCalls: modelCalls, documentModelCalls, rasterGraphs: (codecReport as typeof codecReport & { rasterGraphs: unknown }).rasterGraphs, listeningAddressPlayback: true, passiveAudioLoads: 0, newAudioFiles: 0, audioTransport: "memory-only substitute with real Chromium decoding", nativeDialogs: "substituted", providerCalls: "local substitutes" }, null, 2) + "\n");
  console.log("Electron smoke passed: sandbox, IPC, five Tencent ZIP codecs, LangGraph text/OCR/PDF/image completion, bounded PDFium rendering, source crop calibration and passive completion guards in bounded workers, passive source tickets/copy/fences, explicit source repair/quarantine, fenced task deletion/recovery and stable pagination, complete/revised/selected/stopped-unit bank ZIP export without model work, SQLite CRUD, objective/subjective practice, OS-encrypted test credentials, explicit model calls, all-type ZIP roundtrip, bundled examples, and Settings import/backup/confirmed restore through native-dialog substitutes");
} catch (error) {
  const window = instance.windows()[0];
  if (window && !window.isClosed()) { await window.screenshot({ path: ".build/evidence/electron-smoke-failure.png" }).catch(() => {}); await writeFile(".build/evidence/electron-smoke-failure.txt", await window.locator("body").ariaSnapshot()).catch(() => {}); }
  throw error;
} finally {
  clearTimeout(watchdog);
  await instance.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await instance.close().catch(() => {});
  model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
