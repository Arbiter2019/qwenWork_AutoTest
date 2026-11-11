import { parse } from 'csv-parse/sync';
import type { SampleInput } from './types.ts';

export const CSV_TEMPLATE = '\uFEFFID,Prompt,专家套件ID,模型类型\r\n001,请用一句话解释固定分批执行。, ,标准\r\n002,"请比较方案A与方案B，输出两点建议。",,高级\r\n';
export interface CsvError { line: number; message: string }
export function parseCsv(text: string): { samples: SampleInput[]; errors: CsvError[] } {
  const errors: CsvError[]=[]; const samples:SampleInput[]=[];
  try {
    const records = parse(text,{bom:true,skip_empty_lines:true,info:true,relax_column_count:true}) as unknown as {record:string[];info:{lines:number;empty_lines:number}}[];
    const header=records.shift();
    if(!header || header.record.join(',')!=='ID,Prompt,专家套件ID,模型类型') return {samples:[],errors:[{line:1,message:'表头必须为 ID,Prompt,专家套件ID,模型类型'}]};
    const ids=new Set<string>(); let previousLine=header.info.lines,previousEmpty=header.info.empty_lines;
    for(const {record,info} of records){
      const line=previousLine+1+info.empty_lines-previousEmpty;previousLine=info.lines;previousEmpty=info.empty_lines;
      if(record.length!==4){errors.push({line,message:'每行必须有 4 列'});continue;}
      const [rawId,prompt,rawKit,rawModel]=record;const id=rawId.trim(),expertKitId=rawKit.trim(),model=rawModel.trim()||'标准';
      if(!id)errors.push({line,message:'ID 必填'});
      if(ids.has(id))errors.push({line,message:`ID 重复：${id}`});ids.add(id);
      if(!prompt.trim())errors.push({line,message:'Prompt 必填'});
      if(model!=='标准'&&model!=='高级')errors.push({line,message:'模型类型仅支持 标准/高级'});
      if(model==='标准'||model==='高级')samples.push({id,prompt,expertKitId,model});
    }
    if(!records.length)errors.push({line:2,message:'文件中没有测试样本'});
  }catch(error){const e=error as {lines?:number;message?:string};errors.push({line:e.lines??1,message:e.message??'CSV 格式错误'});}
  return {samples:errors.length?[]:samples,errors};
}
