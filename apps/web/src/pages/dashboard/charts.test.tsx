import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DonutChart, fitAxisLabel, RadarChart } from './charts';

describe('DonutChart', () => {
  it('只为非零的项画扇区', () => {
    render(
      <DonutChart
        label="风险等级分布"
        data={[
          { name: '高危', value: 12 },
          { name: '中危', value: 0 },
          { name: '低危', value: 3 },
        ]}
      />,
    );
    const chart = screen.getByRole('group', { name: '风险等级分布' });
    expect(
      within(chart)
        .getAllByRole('img')
        .map((el) => el.getAttribute('aria-label')),
    ).toEqual(['高危 12', '低危 3']);
  });

  it('全为 0 时显示暂无数据，不渲染空图', () => {
    const { container } = render(
      <DonutChart label="风险等级分布" data={[{ name: '高危', value: 0 }]} />,
    );
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('RadarChart', () => {
  const data = ['甲', '乙', '丙', '丁', '戊', '己'].map((name, i) => ({ name, value: i + 1 }));

  it('每一类一个顶点', () => {
    const { container } = render(<RadarChart label="风险类别雷达图" data={data} />);
    expect(screen.getByRole('group', { name: '风险类别雷达图' })).toBeInTheDocument();
    expect(container.querySelectorAll('.recharts-polar-angle-axis-tick')).toHaveLength(6);
    expect(screen.getByText('戊')).toBeInTheDocument();
  });

  it('没有数据或全为 0 时显示暂无数据，不渲染空图', () => {
    const { container, rerender } = render(<RadarChart label="风险类别雷达图" data={[]} />);
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    rerender(<RadarChart label="风险类别雷达图" data={[{ name: '甲', value: 0 }]} />);
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('少于 3 类时不画雷达（两个顶点连不成面）', () => {
    const { container, rerender } = render(
      <RadarChart label="风险类别雷达图" data={data.slice(0, 2)} />,
    );
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    rerender(<RadarChart label="风险类别雷达图" data={data.slice(0, 3)} />);
    expect(screen.getByRole('group', { name: '风险类别雷达图' })).toBeInTheDocument();
    expect(container.querySelectorAll('.recharts-polar-angle-axis-tick')).toHaveLength(3);
  });

  it('可下钻时顶点能用 Tab 聚焦，回车和空格都触发', async () => {
    const onSelect = vi.fn();
    render(<RadarChart label="风险类别雷达图" data={data.slice(0, 3)} onSelect={onSelect} />);
    const vertices = screen.getAllByRole('link');
    expect(vertices.map((el) => el.getAttribute('aria-label'))).toEqual(['甲 1', '乙 2', '丙 3']);
    await userEvent.tab();
    expect(vertices[0]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: '甲', value: 1 }));
    await userEvent.tab();
    expect(vertices[1]).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: '乙', value: 2 }));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('不可下钻时顶点不可聚焦', () => {
    render(<RadarChart label="风险类别雷达图" data={data.slice(0, 3)} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('雷达图坐标轴文字', () => {
  it('放得下就一行；放不下按宽度对半折两行；两行也放不下才加省略号', () => {
    expect(fitAxisLabel('隐私与敏感信息泄露', 120)).toEqual(['隐私与敏感信息泄露']);
    expect(fitAxisLabel('隐私与敏感信息泄露', 80)).toEqual(['隐私与敏感', '信息泄露']);
    expect(fitAxisLabel('隐私与敏感信息泄露', 36)).toEqual(['隐私与', '敏感…']);
  });

  it('长类别名不截成「隐私与敏感信…」，完整写出（必要时两行）', () => {
    const names = [
      '工具调用/越权代理风险',
      '偏见歧视/公平性风险',
      '数据外传/越权披露风险',
      '有害能力/高风险请求风险',
      '幻觉误导/事实一致性风险',
      '隐私与敏感信息泄露风险',
    ];
    const { container } = render(
      <RadarChart label="风险类别雷达图" data={names.map((name) => ({ name, value: 1 }))} />,
    );
    const texts = [...container.querySelectorAll('.recharts-polar-angle-axis-tick text')].map(
      (t) => t.textContent,
    );
    expect(texts).toContain('隐私与敏感信息泄露');
    expect(texts.join('')).not.toContain('…');
  });

  it('顶点在下方的文字挂在点的下面，不压住顶点；上方的压在点上面；两侧的垂直居中', () => {
    const data = ['上', '右', '下', '左'].map((name) => ({ name, value: 2 }));
    const { container } = render(<RadarChart label="风险类别雷达图" data={data} />);
    const firstDy = (i: number) =>
      Number(
        container
          .querySelectorAll('.recharts-polar-angle-axis-tick text')
          [i]!.querySelector('tspan')!
          .getAttribute('dy'),
      );
    expect(firstDy(0)).toBeLessThanOrEqual(0);
    expect(firstDy(2)).toBeGreaterThanOrEqual(10);
    expect(firstDy(1)).toBeGreaterThan(0);
    expect(firstDy(1)).toBeLessThan(10);
  });
});
