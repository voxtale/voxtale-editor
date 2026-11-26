// Placeholder so root.tsx typechecks; the sandbox replaces it with the
// generated module for each job.
import React from 'react';
import {z, Stage, Panel, Heading, Label, CountUp, useEnter, useExit} from './kit';
export const schema = z.object({value: z.number(), label: z.string()});
export const defaultProps = {value: 42, label: 'subscribers'};
export default function Graphic({value, label}: z.infer<typeof schema>) {
  const enter = useEnter(0), exit = useExit(), count = useEnter(6);
  return <Stage align="end" justify="end"><div style={{opacity: enter * exit}}><Panel><Heading size={96}><CountUp value={value} progress={count} /></Heading><Label>{label}</Label></Panel></div></Stage>;
}
