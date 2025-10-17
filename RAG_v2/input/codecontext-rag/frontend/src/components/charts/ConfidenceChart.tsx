import type React from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

interface ConfidenceChartProps {
  data: Array<{ name: string; confidence: number }>
}

export const ConfidenceChart: React.FC<ConfidenceChartProps> = ({ data }) => {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="confidence" fill="#0ea5e9" />
      </BarChart>
    </ResponsiveContainer>
  )
}