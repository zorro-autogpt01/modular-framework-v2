import React, { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

interface MermaidDiagramProps {
  chart: string
  className?: string
}

mermaid.initialize({ 
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose'
})

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart, className }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    if (!chart) return

    const renderDiagram = async () => {
      try {
        setError('')
        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`
        const { svg } = await mermaid.render(id, chart)
        setSvg(svg)
      } catch (err) {
        console.error('Mermaid render error:', err)
        setError('Failed to render diagram')
      }
    }

    renderDiagram()
  }, [chart])

  if (error) {
    return (
      <div className="p-4 bg-red-50 text-red-700 rounded-lg">
        {error}
      </div>
    )
  }

  return (
    <div 
      ref={containerRef}
      className={className}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}