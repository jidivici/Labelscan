import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from '../../theme';
import { createHygieneWorkflow, type WorkflowKind, type WorkflowField, type HygieneWorkflow } from './workflow';

export const hygieneKinds: {id: WorkflowKind; label: string}[] = [
  {id:'fresh',label:'Fraîcheur et parasites'}, {id:'receipt',label:'Réception'},
  {id:'temp',label:'Températures'}, {id:'tank',label:'Vivier'},
  {id:'clean',label:'Nettoyage'}, {id:'cook',label:'Cuisson / refroidissement'},
  {id:'probe',label:'Vérification sonde'},
];

/** This component is rendered unchanged by the native screen and web test entry. */
export function HygieneWorkflowView({ initialDay, operator, onBack, topInset=0, bottomInset=0 }: {
  initialDay?: string; operator: string; onBack?: () => void; topInset?: number; bottomInset?: number;
}) {
  const [kind,setKind]=useState<WorkflowKind>('fresh');
  const drafts=useRef<Partial<Record<WorkflowKind,HygieneWorkflow>>>({});
  if(!drafts.current[kind]) drafts.current[kind]=createHygieneWorkflow(kind,initialDay?{day:initialDay}:{});
  const engine=drafts.current[kind]!;
  const [index,setIndex]=useState(0);
  const [done,setDone]=useState(false);
  const [errors,setErrors]=useState<string[]>([]);
  const [,refresh]=useState(0);
  const scroll=useRef<ScrollView>(null);
  const steps=engine.steps();
  const current=steps[Math.min(index,steps.length-1)];
  const answers=engine.data();
  function update(key:string,value:string|boolean) {
    engine.update(key,value,current.id);setDone(false);setErrors([]);refresh(v=>v+1);
  }
  function move(next:number) {setIndex(next);setErrors([]);scroll.current?.scrollTo({y:0,animated:true});}
  function advance() {
    if(done){setDone(false);return;}
    const problems=current.id==='visa'?engine.validateAll():engine.validate(current);
    setErrors(problems);
    if(problems.length){return;}
    if(current.id==='visa')setDone(true);else move(index+1);
    scroll.current?.scrollTo({y:0,animated:true});
  }
  function field(f:WorkflowField) {
    const value=answers[f.key];
    return <View key={f.key} style={s.field}>
      {f.type!=='checkbox'&&<Text style={s.label}>{f.label}{f.required?' *':' (facultatif)'}</Text>}
      {f.type==='radio'?<View style={s.options}>{f.options?.map(option=><Pressable key={option} accessibilityRole="radio" accessibilityState={{checked:value===option}} accessibilityLabel={option} onPress={()=>update(f.key,option)} style={[s.option,value===option&&s.selected]}><Text style={[s.body,value===option&&s.selectedText]}>{value===option?'●  ':'○  '}{option}</Text></Pressable>)}</View>:
      f.type==='checkbox'?<Pressable accessibilityRole="checkbox" accessibilityState={{checked:value===true}} accessibilityLabel={f.label} onPress={()=>update(f.key,value!==true)} style={[s.option,value===true&&s.selected]}><Text style={s.body}>{value===true?'☑':'☐'}  {f.label}{f.required?' *':''}</Text></Pressable>:
      <TextInput accessibilityLabel={f.label} testID={`hygiene-${f.key}`} value={typeof value==='string'?value:''} onChangeText={text=>update(f.key,text)} style={[s.input,f.type==='textarea'&&s.multiline]} multiline={f.type==='textarea'} keyboardType={f.type==='number'?(Platform.OS==='ios'?'numbers-and-punctuation':'default'):'default'} autoCapitalize={['date','datetime-local','number'].includes(f.type)?'none':'sentences'} placeholder={f.type==='date'?'AAAA-MM-JJ':f.type==='datetime-local'?'AAAA-MM-JJTHH:mm':f.type==='number'?'Saisir la mesure':undefined} placeholderTextColor={colors.onSurfaceVariant} />}
      {f.type==='date'&&<Text style={s.help}>Exemple : 2026-09-21</Text>}
      {f.type==='datetime-local'&&<Text style={s.help}>Date et heure locales, par exemple 2026-09-21T08:30</Text>}
      {f.help&&<Text style={s.help}>{f.help}</Text>}
    </View>;
  }
  return <KeyboardAvoidingView style={[s.root,{paddingTop:topInset}]} behavior={Platform.OS==='ios'?'padding':undefined}>
    <View style={s.header}>
      {onBack&&<Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Retour aux fiches" style={s.back}><Text style={s.selectedText}>‹ Fiches</Text></Pressable>}
      <View style={{flex:1}}><Text style={s.brand}>LabelScan</Text><Text style={s.help}>Hygiène · Parcours employé</Text></View>
      <View style={s.badge}><Text style={s.selectedText}>TEST</Text></View>
    </View>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={[s.content,{paddingBottom:Math.max(bottomInset,24)}]}>
      <View style={s.notice}><Text style={s.noticeText}>Mode test · Aucun contrôle enregistré</Text><Text style={s.help}>Les saisies restent temporaires. Le visa est une simulation.</Text></View>
      <Text style={s.label}>Quel contrôle effectuez-vous ?</Text>
      <View style={s.options}>{hygieneKinds.map(item=><Pressable key={item.id} accessibilityRole="button" accessibilityState={{selected:kind===item.id}} onPress={()=>{setKind(item.id);setIndex(0);setDone(false);setErrors([]);}} style={[s.chip,kind===item.id&&s.selected]}><Text style={kind===item.id?s.selectedText:s.body}>{item.label}</Text></Pressable>)}</View>
      <Text style={s.help}>Opérateur : {operator}</Text>
      <View style={s.progressRow}><Text style={s.selectedText}>Étape {index+1} sur {steps.length}</Text><Text style={s.help}>{answers.day}</Text></View>
      <View accessibilityRole="progressbar" accessibilityValue={{min:0,max:steps.length,now:index+1}} style={s.track}><View style={[s.fill,{width:`${(index+1)/steps.length*100}%`}]} /></View>
      <View style={s.card}>
        <Text style={s.source}>{current.source}</Text>
        <Text accessibilityRole="header" style={s.title}>{done?'Visa simulé':current.title}</Text>
        {done?<View style={s.notice}><Text style={s.body}>{engine.unfinished()?'Constat incomplet relu.':engine.hasIssue()?'Observations et écart documentés.':'Observations relues et visées.'}</Text><Text style={s.help}>Aucune fiche créée dans LabelScan. Le visa ne clôture pas un incident.</Text></View>:<Text style={s.instruction}>{current.doText}</Text>}
        {current.note&&!done&&<Text style={s.note}>{current.note}</Text>}
        {(current.id==='visa'||done)&&steps.filter(step=>step.id!=='visa').map(step=><View key={step.id} style={s.summary}>
          <Text style={s.label}>{step.title}</Text>
          {engine.fields(step).filter(f=>answers[f.key]!==undefined).map(f=><View key={f.key} style={s.summaryRow}><Text style={s.help}>{f.label}</Text><Text style={s.body}>{answers[f.key]===true?'Confirmé':String(answers[f.key])}</Text></View>)}
        </View>)}
        {(current.id==='visa'||done)&&<Text style={s.instruction}>Visa simulé de {operator} · journée {String(answers.day)}</Text>}
        {!done&&engine.fields(current).map(field)}
        {!done&&engine.notes(current.id).map(note=><Text key={note} style={s.note}>{note}</Text>)}
        {!!errors.length&&<View accessibilityRole="alert" accessibilityLiveRegion="polite" style={s.errors}>{errors.map(error=><Text key={error} style={s.error}>{error}</Text>)}</View>}
        {!done&&current.branch&&<Text style={s.help}>{current.branch}</Text>}
        <View style={s.actions}>
          {!done&&index>0&&<Pressable onPress={()=>move(index-1)} accessibilityRole="button" style={s.option}><Text style={s.body}>Précédent</Text></Pressable>}
          <Pressable onPress={advance} accessibilityRole="button" style={s.primary}><Text style={s.primaryText}>{done?'Revoir le récapitulatif':current.id==='visa'?'Simuler mon visa':'Continuer'}</Text></Pressable>
        </View>
      </View>
      <Text style={s.help}>* Champ obligatoire. Une mesure manquante ne vaut pas conformité. Source : Hygiène.pdf, PMS Produits de la mer, juin 2017.</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}
const s=StyleSheet.create({
 root:{flex:1,backgroundColor:colors.background},
 header:{flexDirection:'row',alignItems:'center',gap:12,padding:16,backgroundColor:colors.surface,borderBottomWidth:1,borderBottomColor:colors.outlineVariant},
 back:{paddingVertical:12,paddingRight:4},brand:{fontSize:21,fontWeight:'700',color:colors.onSurface},badge:{padding:8,borderRadius:8,backgroundColor:colors.primaryContainer},
 content:{width:'100%',maxWidth:720,alignSelf:'center',padding:16,gap:16},body:{fontSize:15,lineHeight:22,color:colors.onSurface},label:{fontSize:15,fontWeight:'600',color:colors.onSurface,lineHeight:22},help:{fontSize:13,lineHeight:19,color:colors.onSurfaceVariant},
 notice:{padding:14,borderRadius:12,backgroundColor:colors.primaryContainer,gap:4},noticeText:{fontSize:14,fontWeight:'600',color:colors.onPrimaryContainer},
 options:{flexDirection:'row',flexWrap:'wrap',gap:8},chip:{minHeight:44,padding:12,borderRadius:10,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.outlineVariant},
 option:{minHeight:48,padding:12,borderRadius:10,borderWidth:1,borderColor:colors.outlineVariant,justifyContent:'center',flexShrink:1},selected:{backgroundColor:colors.primaryContainer,borderColor:colors.primary},selectedText:{color:colors.primary,fontSize:14,fontWeight:'600'},
 progressRow:{flexDirection:'row',justifyContent:'space-between',gap:8},track:{height:4,backgroundColor:colors.outlineVariant,borderRadius:4},fill:{height:4,backgroundColor:colors.primary,borderRadius:4},
 card:{backgroundColor:colors.surface,borderRadius:16,padding:20,gap:16,borderWidth:1,borderColor:colors.outlineVariant},source:{fontSize:12,color:colors.onSurfaceVariant},title:{fontSize:24,fontWeight:'600',color:colors.onSurface,lineHeight:30},instruction:{fontSize:15,lineHeight:23,color:colors.onPrimaryContainer,backgroundColor:colors.primaryContainer,padding:14,borderRadius:10},
 field:{gap:8},input:{minHeight:48,borderWidth:1,borderColor:colors.outline,padding:12,borderRadius:10,fontSize:16,color:colors.onSurface,backgroundColor:colors.surface},multiline:{minHeight:88,textAlignVertical:'top'},
 note:{fontSize:14,lineHeight:21,padding:14,borderRadius:10,backgroundColor:colors.warningContainer,color:colors.onWarningContainer},summary:{gap:8},summaryRow:{borderBottomWidth:1,borderBottomColor:colors.outlineVariant,paddingVertical:8,gap:3},errors:{backgroundColor:colors.errorContainer,padding:14,borderRadius:10,gap:8},error:{fontSize:14,lineHeight:21,color:colors.onErrorContainer},actions:{flexDirection:'row',flexWrap:'wrap',gap:12,marginTop:8},primary:{minHeight:48,flexGrow:1,padding:14,borderRadius:10,backgroundColor:colors.primary,alignItems:'center',justifyContent:'center'},primaryText:{color:colors.onPrimary,fontSize:15,fontWeight:'600'},
});
