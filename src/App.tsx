import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell, BarChart, Bar, Legend } from 'recharts';
import { Calculator, TrendingUp, History, Trash2, Save, Share2, Info, Target, Download, Moon, Sun, GitCompare, TrendingDown } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';

interface CalculationResult {
  id: string;
  type: 'compound' | 'installment';
  principal: number;
  rate: number;
  years: number;
  frequency: number;
  monthlyAddition?: number;
  finalAmount: number;
  totalInterest: number;
  totalPrincipal: number;
  date: string;
  yearlyData: Array<{
    year: number;
    principal: number;
    interest: number;
    total: number;
  }>;
}

interface PlanAdjustment {
  id: string;
  date: string;
  amount: number;
}

interface SavingsPlan {
  id: string;
  name: string;
  deadline: string;
  targetAmount: number;
  currentAmount: number;
  expectedRate: number;
  adjustments: PlanAdjustment[];
}

interface PlanMetrics {
  daysRemaining: number;
  yearsRemaining: number;
  futureValueCurrent: number;
  futureValueAdjustments: number;
  projectedWithoutRegularSaving: number;
  fundingGap: number;
  yearlySaving: number;
  monthlySaving: number;
  dailySaving: number;
  requiredAnnualRate: number | null;
}

const frequencyOptions = [
  { value: '1', label: '每年' },
  { value: '2', label: '每半年' },
  { value: '4', label: '每季度' },
  { value: '12', label: '每月' },
  { value: '52', label: '每周' },
  { value: '365', label: '每天' },
];

const createDefaultPlan = (): SavingsPlan => {
  const nextYear = new Date();
  nextYear.setFullYear(nextYear.getFullYear() + 1);

  return {
    id: Date.now().toString(),
    name: '计划 1',
    deadline: nextYear.toISOString().slice(0, 10),
    targetAmount: 300000,
    currentAmount: 10000,
    expectedRate: 5,
    adjustments: [],
  };
};

const calculatePlanMetrics = (plan: SavingsPlan): PlanMetrics => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const deadlineDate = new Date(plan.deadline);
  const deadline = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.max(0, Math.ceil((deadline.getTime() - today.getTime()) / msPerDay));
  const yearsRemaining = daysRemaining / 365;
  const annualRate = plan.expectedRate / 100;

  if (daysRemaining <= 0) {
    const projected = plan.currentAmount + plan.adjustments.reduce((sum, adj) => sum + (adj.amount || 0), 0);
    const gap = Math.max(0, plan.targetAmount - projected);
    return {
      daysRemaining,
      yearsRemaining,
      futureValueCurrent: projected,
      futureValueAdjustments: 0,
      projectedWithoutRegularSaving: projected,
      fundingGap: gap,
      yearlySaving: gap,
      monthlySaving: gap,
      dailySaving: gap,
      requiredAnnualRate: null,
    };
  }

  const growthFactor = Math.pow(1 + annualRate, yearsRemaining);
  const futureValueCurrent = plan.currentAmount * growthFactor;

  const futureValueAdjustments = plan.adjustments.reduce((sum, adjustment) => {
    const adjustmentDate = new Date(adjustment.date);
    const adj = new Date(adjustmentDate.getFullYear(), adjustmentDate.getMonth(), adjustmentDate.getDate());

    if (Number.isNaN(adj.getTime())) {
      return sum;
    }

    const daysToDeadline = Math.ceil((deadline.getTime() - adj.getTime()) / msPerDay);
    if (daysToDeadline <= 0) {
      return sum + adjustment.amount;
    }

    const yearsToDeadline = daysToDeadline / 365;
    return sum + adjustment.amount * Math.pow(1 + annualRate, yearsToDeadline);
  }, 0);

  const projectedWithoutRegularSaving = futureValueCurrent + futureValueAdjustments;
  const fundingGap = Math.max(0, plan.targetAmount - projectedWithoutRegularSaving);

  const calculateRequiredPeriodicSaving = (periodDays: number) => {
    const periods = Math.max(1, Math.ceil(daysRemaining / periodDays));
    const periodRate = Math.pow(1 + annualRate, periodDays / 365) - 1;
    const factor = periodRate === 0
      ? periods
      : (Math.pow(1 + periodRate, periods) - 1) / periodRate;

    return fundingGap / factor;
  };

  const yearlySaving = calculateRequiredPeriodicSaving(365);
  const monthlySaving = calculateRequiredPeriodicSaving(30);
  const dailySaving = calculateRequiredPeriodicSaving(1);

  const evaluateFutureValueWithoutRegular = (rate: number) => {
    const currentPart = plan.currentAmount * Math.pow(1 + rate, yearsRemaining);
    const adjustmentPart = plan.adjustments.reduce((sum, adjustment) => {
      const adjustmentDate = new Date(adjustment.date);
      const adj = new Date(adjustmentDate.getFullYear(), adjustmentDate.getMonth(), adjustmentDate.getDate());
      if (Number.isNaN(adj.getTime())) {
        return sum;
      }
      const daysToDeadline = Math.ceil((deadline.getTime() - adj.getTime()) / msPerDay);
      if (daysToDeadline <= 0) {
        return sum + adjustment.amount;
      }
      return sum + adjustment.amount * Math.pow(1 + rate, daysToDeadline / 365);
    }, 0);

    return currentPart + adjustmentPart;
  };

  const baseValue = evaluateFutureValueWithoutRegular(0);
  let requiredAnnualRate: number | null = null;

  if (plan.targetAmount <= baseValue) {
    requiredAnnualRate = 0;
  } else {
    const maxRate = 2;
    const maxValue = evaluateFutureValueWithoutRegular(maxRate);
    if (maxValue >= plan.targetAmount) {
      let low = 0;
      let high = maxRate;
      for (let i = 0; i < 80; i++) {
        const mid = (low + high) / 2;
        if (evaluateFutureValueWithoutRegular(mid) >= plan.targetAmount) {
          high = mid;
        } else {
          low = mid;
        }
      }
      requiredAnnualRate = high * 100;
    }
  }

  return {
    daysRemaining,
    yearsRemaining,
    futureValueCurrent,
    futureValueAdjustments,
    projectedWithoutRegularSaving,
    fundingGap,
    yearlySaving,
    monthlySaving,
    dailySaving,
    requiredAnnualRate,
  };
};

export default function App() {
  // 基础复利计算状态
  const [principal, setPrincipal] = useState<string>('10000');
  const [rate, setRate] = useState<string>('5');
  const [years, setYears] = useState<string>('10');
  const [frequency, setFrequency] = useState<string>('12');
  
  // 定投计算状态
  const [monthlyAddition, setMonthlyAddition] = useState<string>('1000');
  const [showInstallment, setShowInstallment] = useState<boolean>(false);
  
  // 结果状态
  const [result, setResult] = useState<CalculationResult | null>(null);
  const [history, setHistory] = useState<CalculationResult[]>([]);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  
  // 新功能状态
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [targetAmount, setTargetAmount] = useState<string>('1000000');
  const [inflationRate, setInflationRate] = useState<string>('3');
  const [enableInflation, setEnableInflation] = useState<boolean>(false);
  const [compareMode, setCompareMode] = useState<boolean>(false);
  const [compareResults, setCompareResults] = useState<CalculationResult[]>([]);
  const [calculationMode, setCalculationMode] = useState<'normal' | 'target' | 'target-rate' | 'target-years'>('normal');
  
  // 反推结果状态
  const [calculatedRate, setCalculatedRate] = useState<number | null>(null);
  const [calculatedYears, setCalculatedYears] = useState<number | null>(null);

  // 计划功能状态
  const [plans, setPlans] = useState<SavingsPlan[]>([createDefaultPlan()]);
  const [activePlanId, setActivePlanId] = useState<string>('');

  useEffect(() => {
    const savedPlans = localStorage.getItem('compoundCalculatorPlans');
    if (!savedPlans) return;

    try {
      const parsed = JSON.parse(savedPlans) as SavingsPlan[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        setPlans(parsed);
        setActivePlanId(parsed[0].id);
      }
    } catch (error) {
      console.error('Failed to parse plans:', error);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('compoundCalculatorPlans', JSON.stringify(plans));
  }, [plans]);

  useEffect(() => {
    if (!activePlanId && plans.length > 0) {
      setActivePlanId(plans[0].id);
    }
  }, [plans, activePlanId]);

  const activePlan = useMemo(
    () => plans.find((plan) => plan.id === activePlanId) ?? null,
    [plans, activePlanId]
  );

  const activePlanMetrics = useMemo(
    () => (activePlan ? calculatePlanMetrics(activePlan) : null),
    [activePlan]
  );

  const addPlan = () => {
    const newPlan: SavingsPlan = {
      ...createDefaultPlan(),
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: `计划 ${plans.length + 1}`,
    };

    setPlans((prev) => [...prev, newPlan]);
    setActivePlanId(newPlan.id);
    toast.success('已新增计划');
  };

  const removePlan = (id: string) => {
    if (plans.length <= 1) {
      toast.error('至少保留一个计划');
      return;
    }

    const nextPlans = plans.filter((plan) => plan.id !== id);
    setPlans(nextPlans);
    if (activePlanId === id) {
      setActivePlanId(nextPlans[0]?.id ?? '');
    }
    toast.success('计划已删除');
  };

  const updateActivePlan = (patch: Partial<SavingsPlan>) => {
    if (!activePlanId) return;
    setPlans((prev) =>
      prev.map((plan) => (plan.id === activePlanId ? { ...plan, ...patch } : plan))
    );
  };

  const addAdjustment = () => {
    if (!activePlan) return;

    const defaultDate = activePlan.deadline;
    const newAdjustment: PlanAdjustment = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      date: defaultDate,
      amount: 10000,
    };

    updateActivePlan({ adjustments: [...activePlan.adjustments, newAdjustment] });
  };

  const updateAdjustment = (adjustmentId: string, patch: Partial<PlanAdjustment>) => {
    if (!activePlan) return;

    updateActivePlan({
      adjustments: activePlan.adjustments.map((adjustment) =>
        adjustment.id === adjustmentId ? { ...adjustment, ...patch } : adjustment
      ),
    });
  };

  const removeAdjustment = (adjustmentId: string) => {
    if (!activePlan) return;

    updateActivePlan({
      adjustments: activePlan.adjustments.filter((adjustment) => adjustment.id !== adjustmentId),
    });
  };

  // 从本地存储加载历史记录
  useEffect(() => {
    const saved = localStorage.getItem('compoundCalculatorHistory');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse history:', e);
      }
    }
  }, []);

  // 保存历史记录到本地存储
  useEffect(() => {
    localStorage.setItem('compoundCalculatorHistory', JSON.stringify(history));
  }, [history]);

  // 计算复利
  const calculateCompound = useCallback(() => {
    const p = parseFloat(principal) || 0;
    const r = (parseFloat(rate) || 0) / 100;
    const t = parseFloat(years) || 0;
    const n = parseInt(frequency) || 12;
    const monthly = parseFloat(monthlyAddition) || 0;

    const yearlyData = [];
    let currentPrincipal = p;
    let totalInvested = p;
    
    for (let year = 0; year <= t; year++) {
      if (year === 0) {
        yearlyData.push({
          year,
          principal: p,
          interest: 0,
          total: p
        });
        continue;
      }

      // 计算每年的复利
      const amountBeforeAddition = currentPrincipal * Math.pow(1 + r / n, n);
      
      // 如果启用定投，添加每年的定投金额
      if (showInstallment && monthly > 0) {
        const yearlyAddition = monthly * 12;
        // 定投部分的复利计算（简化计算，假设年末投入）
        const futureValueOfAdditions = yearlyAddition * (Math.pow(1 + r / n, n) - 1) / (r / n);
        currentPrincipal = amountBeforeAddition + futureValueOfAdditions;
        totalInvested += yearlyAddition;
      } else {
        currentPrincipal = amountBeforeAddition;
      }

      const totalInterest = currentPrincipal - totalInvested;
      
      yearlyData.push({
        year,
        principal: totalInvested,
        interest: totalInterest,
        total: currentPrincipal
      });
    }

    const finalAmount = yearlyData[yearlyData.length - 1].total;
    const totalPrincipal = yearlyData[yearlyData.length - 1].principal;
    const totalInterest = finalAmount - totalPrincipal;

    const newResult: CalculationResult = {
      id: Date.now().toString(),
      type: showInstallment ? 'installment' : 'compound',
      principal: p,
      rate: parseFloat(rate) || 0,
      years: t,
      frequency: n,
      monthlyAddition: showInstallment ? monthly : undefined,
      finalAmount,
      totalInterest,
      totalPrincipal,
      date: new Date().toLocaleString('zh-CN'),
      yearlyData
    };

    setResult(newResult);
    return newResult;
  }, [principal, rate, years, frequency, monthlyAddition, showInstallment]);

  // 目标金额反推计算所需本金
  const calculateTargetPrincipal = useCallback(() => {
    const target = parseFloat(targetAmount) || 0;
    const r = (parseFloat(rate) || 0) / 100;
    const t = parseFloat(years) || 0;
    const n = parseInt(frequency) || 12;
    const monthly = parseFloat(monthlyAddition) || 0;

    if (showInstallment && monthly > 0) {
      // 定投模式：需要迭代计算
      let estimatedPrincipal = 1000;
      let iterations = 0;
      const maxIterations = 100;
      
      while (iterations < maxIterations) {
        let currentAmount = estimatedPrincipal;
        let totalInvested = estimatedPrincipal;
        
        for (let year = 1; year <= t; year++) {
          currentAmount = currentAmount * Math.pow(1 + r / n, n);
          const yearlyAddition = monthly * 12;
          const futureValueOfAdditions = yearlyAddition * (Math.pow(1 + r / n, n) - 1) / (r / n);
          currentAmount += futureValueOfAdditions;
          totalInvested += yearlyAddition;
        }
        
        if (Math.abs(currentAmount - target) < 1) {
          toast.success(`需要初始本金约 ¥${estimatedPrincipal.toFixed(2)}`);
          setPrincipal(estimatedPrincipal.toFixed(0));
          return;
        }
        
        estimatedPrincipal += (target - currentAmount) / Math.pow(1 + r / n, n * t);
        iterations++;
      }
    } else {
      // 一次性投资：直接计算
      const requiredPrincipal = target / Math.pow(1 + r / n, n * t);
      setPrincipal(requiredPrincipal.toFixed(0));
      toast.success(`需要初始本金约 ¥${requiredPrincipal.toFixed(2)}`);
    }
  }, [targetAmount, rate, years, frequency, monthlyAddition, showInstallment]);

  // 反推所需利率
  const calculateTargetRate = useCallback(() => {
    const p = parseFloat(principal) || 0;
    const target = parseFloat(targetAmount) || 0;
    const t = parseFloat(years) || 0;
    const n = parseInt(frequency) || 12;
    const monthly = parseFloat(monthlyAddition) || 0;

    if (p === 0 || target === 0 || t === 0) {
      toast.error('请输入有效的本金、目标金额和年限');
      return;
    }

    if (showInstallment && monthly > 0) {
      // 定投模式：二分法迭代计算
      let low = 0;
      let high = 1; // 最高100%年利率
      let iterations = 0;
      const maxIterations = 100;
      const tolerance = 0.01;
      
      while (iterations < maxIterations && (high - low) > 0.00001) {
        const midRate = (low + high) / 2;
        let currentAmount = p;
        
        for (let year = 1; year <= t; year++) {
          currentAmount = currentAmount * Math.pow(1 + midRate / n, n);
          const yearlyAddition = monthly * 12;
          if (midRate > 0) {
            const futureValueOfAdditions = yearlyAddition * (Math.pow(1 + midRate / n, n) - 1) / (midRate / n);
            currentAmount += futureValueOfAdditions;
          } else {
            currentAmount += yearlyAddition;
          }
        }
        
        if (Math.abs(currentAmount - target) < tolerance) {
          const annualRate = midRate * 100;
          setCalculatedRate(annualRate);
          setRate(annualRate.toFixed(2));
          toast.success(`需要年利率约 ${annualRate.toFixed(2)}%`);
          return;
        }
        
        if (currentAmount < target) {
          low = midRate;
        } else {
          high = midRate;
        }
        iterations++;
      }
      
      toast.error('无法计算出合理的利率，请调整参数');
    } else {
      // 一次性投资：直接计算
      // FV = PV * (1 + r/n)^(nt)
      // r = n * ((FV/PV)^(1/(nt)) - 1)
      const r = n * (Math.pow(target / p, 1 / (n * t)) - 1);
      const annualRate = r * 100;
      setCalculatedRate(annualRate);
      setRate(annualRate.toFixed(2));
      toast.success(`需要年利率约 ${annualRate.toFixed(2)}%`);
    }
  }, [principal, targetAmount, years, frequency, monthlyAddition, showInstallment]);

  // 反推所需年限
  const calculateTargetYears = useCallback(() => {
    const p = parseFloat(principal) || 0;
    const target = parseFloat(targetAmount) || 0;
    const r = (parseFloat(rate) || 0) / 100;
    const n = parseInt(frequency) || 12;
    const monthly = parseFloat(monthlyAddition) || 0;

    if (p === 0 || target === 0 || r === 0) {
      toast.error('请输入有效的本金、目标金额和利率');
      return;
    }

    if (target <= p && !(showInstallment && monthly > 0)) {
      toast.error('目标金额必须大于初始本金');
      return;
    }

    if (showInstallment && monthly > 0) {
      // 定投模式：迭代计算
      let estimatedYears = 1;
      let currentAmount = 0;
      
      while (estimatedYears <= 100 && currentAmount < target) {
        currentAmount = p;
        for (let year = 1; year <= estimatedYears; year++) {
          currentAmount = currentAmount * Math.pow(1 + r / n, n);
          const yearlyAddition = monthly * 12;
          const futureValueOfAdditions = yearlyAddition * (Math.pow(1 + r / n, n) - 1) / (r / n);
          currentAmount += futureValueOfAdditions;
        }
        
        if (currentAmount >= target) {
          setCalculatedYears(estimatedYears);
          setYears(estimatedYears.toString());
          toast.success(`需要投资约 ${estimatedYears} 年`);
          return;
        }
        estimatedYears++;
      }
      
      toast.error('目标金额过高，100年内无法达成');
    } else {
      // 一次性投资：直接计算
      // FV = PV * (1 + r/n)^(nt)
      // t = ln(FV/PV) / (n * ln(1 + r/n))
      const t = Math.log(target / p) / (n * Math.log(1 + r / n));
      setCalculatedYears(t);
      setYears(Math.ceil(t).toString());
      toast.success(`需要投资约 ${t.toFixed(1)} 年 (${Math.ceil(t)} 年)`);
    }
  }, [principal, targetAmount, rate, frequency, monthlyAddition, showInstallment]);

  // 计算考虑通胀的实际购买力
  const calculateWithInflation = useCallback((amount: number, years: number) => {
    if (!enableInflation) return amount;
    const inflation = (parseFloat(inflationRate) || 0) / 100;
    return amount / Math.pow(1 + inflation, years);
  }, [enableInflation, inflationRate]);

  // 添加到对比列表
  const addToCompare = () => {
    if (!result) return;
    if (compareResults.some(r => r.id === result.id)) {
      toast.info('该方案已在对比列表中');
      return;
    }
    if (compareResults.length >= 3) {
      toast.error('最多只能对比3个方案');
      return;
    }
    setCompareResults(prev => [...prev, result]);
    toast.success('已添加到对比列表');
  };

  // 删除对比方案
  const removeFromCompare = (id: string) => {
    setCompareResults(prev => prev.filter(r => r.id !== id));
    toast.success('已移除');
  };

  // 导出报告
  const exportReport = () => {
    if (!result) return;
    
    const report = `
==============================================
         复利计算器 - 投资分析报告
==============================================

生成时间: ${new Date().toLocaleString('zh-CN')}

【基本信息】
计算类型: ${result.type === 'installment' ? '定投模式' : '一次性投资'}
初始本金: ¥${result.principal.toLocaleString()}
投资年限: ${result.years}年
复利频率: ${frequencyOptions.find(f => f.value === result.frequency.toString())?.label}
${result.monthlyAddition ? `每月定投: ¥${result.monthlyAddition.toLocaleString()}` : ''}

【利率详情】
年利率: ${result.rate}%
月利率: ${(result.rate / 12).toFixed(4)}%
周利率: ${(result.rate / 52).toFixed(4)}%
日利率: ${(result.rate / 365).toFixed(4)}%
实际年化收益率: ${result.rate}%

【收益分析】
最终金额: ${formatMoney(result.finalAmount)}
投入本金: ${formatMoney(result.totalPrincipal)}
总收益: ${formatMoney(result.totalInterest)}
总收益率: ${((result.totalInterest / result.totalPrincipal) * 100).toFixed(2)}%
年均收益: ${formatMoney(result.totalInterest / result.years)}

${enableInflation ? `【通胀调整】
通胀率: ${inflationRate}%
实际购买力: ${formatMoney(calculateWithInflation(result.finalAmount, result.years))}
购买力损失: ${formatMoney(result.finalAmount - calculateWithInflation(result.finalAmount, result.years))}
实际收益率: ${((calculateWithInflation(result.finalAmount, result.years) - result.totalPrincipal) / result.totalPrincipal * 100).toFixed(2)}%
` : ''}

【时间换算】
投资时长: ${result.years}年
等于: ${result.years * 12}个月 / ${result.years * 52}周 / ${result.years * 365}天

【逐年明细】
年份\t本金累计\t\t收益累计\t\t总资产
${result.yearlyData.map(data => 
  `${data.year}\t${formatMoney(data.principal)}\t${formatMoney(data.interest)}\t${formatMoney(data.total)}`
).join('\n')}

【投资建议】
• 复利的威力需要时间来展现，长期投资往往效果更佳
• 稳定的收益率比高但不稳定的收益率更可靠
• 定期定额投资可以平滑市场波动风险
• 请根据自身风险承受能力选择合适的投资产品

==============================================
本报告仅供参考，不构成投资建议
投资有风险，入市需谨慎
© 2026 复利计算器
==============================================
    `;
    
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `复利计算报告-${new Date().getTime()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('报告已导出');
  };

  // 保存到历史记录
  const saveToHistory = () => {
    if (!result) return;
    const exists = history.some(h => 
      h.principal === result.principal && 
      h.rate === result.rate && 
      h.years === result.years &&
      h.frequency === result.frequency &&
      h.monthlyAddition === result.monthlyAddition
    );
    
    if (!exists) {
      setHistory(prev => [result, ...prev].slice(0, 50));
      toast.success('已保存到历史记录');
    } else {
      toast.info('该计算结果已存在');
    }
  };

  // 删除历史记录
  const deleteHistory = (id: string) => {
    setHistory(prev => prev.filter(h => h.id !== id));
    toast.success('已删除');
  };

  // 加载历史记录
  const loadHistory = (item: CalculationResult) => {
    setPrincipal(item.principal.toString());
    setRate(item.rate.toString());
    setYears(item.years.toString());
    setFrequency(item.frequency.toString());
    if (item.monthlyAddition) {
      setMonthlyAddition(item.monthlyAddition.toString());
      setShowInstallment(true);
    } else {
      setShowInstallment(false);
    }
    setResult(item);
    setShowHistory(false);
    toast.success('已加载历史记录');
  };

  // 分享结果
  const shareResult = async () => {
    if (!result) return;
    const text = `复利计算器 - 投资分析结果

💰 最终金额：¥${result.finalAmount.toLocaleString()}
📈 总收益：¥${result.totalInterest.toLocaleString()}
💵 投入本金：¥${result.totalPrincipal.toLocaleString()}
📊 收益率：${((result.totalInterest / result.totalPrincipal) * 100).toFixed(2)}%

基本信息：
• 初始本金：¥${result.principal.toLocaleString()}
• 年利率：${result.rate}%
• 月利率：${(result.rate / 12).toFixed(4)}%
• 日利率：${(result.rate / 365).toFixed(4)}%
• 投资年限：${result.years}年
${result.monthlyAddition ? `• 每月定投：¥${result.monthlyAddition.toLocaleString()}` : ''}

— 复利计算器 2026`;
    
    try {
      await navigator.clipboard.writeText(text);
      toast.success('结果已复制到剪贴板');
    } catch (err) {
      toast.error('复制失败');
    }
  };

  // 格式化金额
  const formatMoney = (amount: number) => {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: 'CNY',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  };

  // 初始计算
  useEffect(() => {
    calculateCompound();
  }, []);

  return (
    <div className={`min-h-screen ${darkMode ? 'bg-gray-900' : 'bg-gradient-to-br from-blue-50 to-indigo-100'} p-4 md:p-8 transition-colors`}>
      <Toaster position="top-center" />
      
      <div className="max-w-6xl mx-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg">
              <Calculator className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className={`text-2xl md:text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>复利计算器</h1>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>让财富滚雪球，轻松规划未来</p>
            </div>
          </div>
          
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setDarkMode(!darkMode)}
              title="切换主题"
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </Button>
            
            <Button
              variant={compareMode ? "default" : "outline"}
              size="icon"
              onClick={() => setCompareMode(!compareMode)}
              title="对比模式"
            >
              <GitCompare className="w-5 h-5" />
            </Button>
            
            <Dialog open={showHistory} onOpenChange={setShowHistory}>
              <DialogTrigger asChild>
                <Button variant="outline" size="icon" className="relative">
                  <History className="w-5 h-5" />
                  {history.length > 0 && (
                    <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                      {history.length}
                    </span>
                  )}
                </Button>
              </DialogTrigger>
              <DialogContent className={`max-w-md max-h-[80vh] ${darkMode ? 'bg-gray-800 border-gray-700' : ''}`}>
                <DialogHeader>
                  <DialogTitle className={darkMode ? 'text-white' : ''}>历史记录</DialogTitle>
                </DialogHeader>
                <ScrollArea className="h-[60vh]">
                  {history.length === 0 ? (
                    <p className={`text-center py-8 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>暂无历史记录</p>
                  ) : (
                    <div className="space-y-3">
                      {history.map((item) => (
                        <Card key={item.id} className={`cursor-pointer transition-colors ${darkMode ? 'bg-gray-700 hover:bg-gray-600 border-gray-600' : 'hover:bg-gray-50'}`}>
                          <CardContent className="p-4">
                            <div className="flex justify-between items-start">
                              <div onClick={() => loadHistory(item)} className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className={`text-xs px-2 py-0.5 rounded ${item.type === 'installment' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                    {item.type === 'installment' ? '定投' : '复利'}
                                  </span>
                                  <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>{item.date}</span>
                                </div>
                                <p className={`font-semibold ${darkMode ? 'text-gray-100' : 'text-gray-900'}`}>
                                  本金 ¥{item.principal.toLocaleString()} → ¥{item.finalAmount.toLocaleString()}
                                </p>
                                <p className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                                  {item.rate}% / {item.years}年 / {frequencyOptions.find(f => f.value === item.frequency.toString())?.label}
                                </p>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteHistory(item.id);
                                }}
                              >
                                <Trash2 className="w-4 h-4 text-red-500" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* 左侧：输入区域 */}
          <Card className={`shadow-xl ${darkMode ? 'bg-gray-800 border-gray-700' : ''}`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className={`flex items-center gap-2 ${darkMode ? 'text-white' : ''}`}>
                  <TrendingUp className="w-5 h-5 text-blue-600" />
                  计算参数
                </CardTitle>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-4">
                <Button
                  variant={calculationMode === 'normal' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setCalculationMode('normal');
                    setCalculatedRate(null);
                    setCalculatedYears(null);
                  }}
                  className="text-xs"
                >
                  正常计算
                </Button>
                <Button
                  variant={calculationMode === 'target' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setCalculationMode('target');
                    setCalculatedRate(null);
                    setCalculatedYears(null);
                  }}
                  className="text-xs"
                >
                  <Target className="w-3 h-3 mr-1" />
                  反推本金
                </Button>
                <Button
                  variant={calculationMode === 'target-rate' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setCalculationMode('target-rate');
                    setCalculatedRate(null);
                    setCalculatedYears(null);
                  }}
                  className="text-xs"
                >
                  反推利率
                </Button>
                <Button
                  variant={calculationMode === 'target-years' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setCalculationMode('target-years');
                    setCalculatedRate(null);
                    setCalculatedYears(null);
                  }}
                  className="text-xs"
                >
                  反推年限
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {(calculationMode === 'target' || calculationMode === 'target-rate' || calculationMode === 'target-years') && (
                <div className={`space-y-2 p-4 rounded-lg border-2 ${darkMode ? 'bg-blue-900/20 border-blue-800' : 'bg-blue-50 border-blue-200'}`}>
                  <Label htmlFor="targetAmount" className={`text-base font-medium ${darkMode ? 'text-white' : ''}`}>
                    目标金额 (¥)
                  </Label>
                  <Input
                    id="targetAmount"
                    type="number"
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(e.target.value)}
                    placeholder="输入你想达到的目标金额"
                    className={`text-lg h-12 ${darkMode ? 'bg-gray-700 text-white border-gray-600 placeholder:text-gray-300' : ''}`}
                  />
                  <Button
                    onClick={() => {
                      if (calculationMode === 'target') calculateTargetPrincipal();
                      else if (calculationMode === 'target-rate') calculateTargetRate();
                      else if (calculationMode === 'target-years') calculateTargetYears();
                    }}
                    className="w-full mt-2"
                    variant="secondary"
                  >
                    <Calculator className="w-4 h-4 mr-2" />
                    {calculationMode === 'target' && '计算所需本金'}
                    {calculationMode === 'target-rate' && '计算所需利率'}
                    {calculationMode === 'target-years' && '计算所需年限'}
                  </Button>
                  {calculatedRate !== null && calculationMode === 'target-rate' && (
                    <div className="mt-2 p-3 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800">
                      <p className={`text-sm font-medium ${darkMode ? 'text-green-300' : 'text-green-700'}`}>
                        📊 计算结果：年利率 {calculatedRate.toFixed(2)}%
                      </p>
                      <div className={`text-xs mt-2 space-y-1 ${darkMode ? 'text-green-400' : 'text-green-600'}`}>
                        <p>• 月利率：{(calculatedRate / 12).toFixed(4)}%</p>
                        <p>• 周利率：{(calculatedRate / 52).toFixed(4)}%</p>
                        <p>• 日利率：{(calculatedRate / 365).toFixed(4)}%</p>
                      </div>
                    </div>
                  )}
                  {calculatedYears !== null && calculationMode === 'target-years' && (
                    <div className="mt-2 p-3 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800">
                      <p className={`text-sm font-medium ${darkMode ? 'text-green-300' : 'text-green-700'}`}>
                        ⏱️ 计算结果：需要 {calculatedYears.toFixed(1)} 年
                      </p>
                      <div className={`text-xs mt-2 space-y-1 ${darkMode ? 'text-green-400' : 'text-green-600'}`}>
                        <p>• 约 {Math.ceil(calculatedYears * 12)} 个月</p>
                        <p>• 约 {Math.ceil(calculatedYears * 52)} 周</p>
                        <p>• 约 {Math.ceil(calculatedYears * 365)} 天</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
              
              {/* 本金输入 */}
              <div className="space-y-2">
                <Label htmlFor="principal" className={`text-base font-medium ${darkMode ? 'text-gray-200' : ''}`}>
                  初始本金 (¥)
                </Label>
                <Input
                  id="principal"
                  type="number"
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value)}
                  placeholder="请输入初始本金"
                  className={`text-lg h-12 ${darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}`}
                />
              </div>

              {/* 年利率输入 */}
              <div className="space-y-2">
                <Label htmlFor="rate" className={`text-base font-medium ${darkMode ? 'text-gray-200' : ''}`}>
                  年利率 (%)
                </Label>
                <Input
                  id="rate"
                  type="number"
                  step="0.01"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="请输入年利率"
                  className={`text-lg h-12 ${darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}`}
                />
                <div className="flex gap-2 flex-wrap">
                  {['3', '4', '5', '6', '8', '10'].map((r) => (
                    <Button
                      key={r}
                      variant={rate === r ? "default" : "outline"}
                      size="sm"
                      onClick={() => setRate(r)}
                    >
                      {r}%
                    </Button>
                  ))}
                </div>
              </div>

              {/* 投资年限输入 */}
              <div className="space-y-2">
                <Label htmlFor="years" className={`text-base font-medium ${darkMode ? 'text-gray-200' : ''}`}>
                  投资年限 (年)
                </Label>
                <Input
                  id="years"
                  type="number"
                  value={years}
                  onChange={(e) => setYears(e.target.value)}
                  placeholder="请输入投资年限"
                  className={`text-lg h-12 ${darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}`}
                />
                <div className="flex gap-2 flex-wrap">
                  {['5', '10', '15', '20', '30'].map((y) => (
                    <Button
                      key={y}
                      variant={years === y ? "default" : "outline"}
                      size="sm"
                      onClick={() => setYears(y)}
                    >
                      {y}年
                    </Button>
                  ))}
                </div>
              </div>

              {/* 复利频率选择 */}
              <div className="space-y-2">
                <Label htmlFor="frequency" className={`text-base font-medium ${darkMode ? 'text-gray-200' : ''}`}>
                  复利频率
                </Label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger className={`h-12 ${darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}`}>
                    <SelectValue placeholder="选择复利频率" />
                  </SelectTrigger>
                  <SelectContent>
                    {frequencyOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 定投开关 */}
              <div className={`flex items-center justify-between p-4 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-3">
                  <div>
                    <Label htmlFor="installment" className={`text-base font-medium cursor-pointer ${darkMode ? 'text-white' : ''}`}>
                      启用定投
                    </Label>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>每月定期追加投资</p>
                  </div>
                </div>
                <Switch
                  id="installment"
                  checked={showInstallment}
                  onCheckedChange={setShowInstallment}
                />
              </div>

              {/* 定投金额输入 */}
              {showInstallment && (
                <div className="space-y-2 animate-in slide-in-from-top-2">
                  <Label htmlFor="monthlyAddition" className={`text-base font-medium ${darkMode ? 'text-gray-200' : ''}`}>
                    每月定投金额 (¥)
                  </Label>
                  <Input
                    id="monthlyAddition"
                    type="number"
                    value={monthlyAddition}
                    onChange={(e) => setMonthlyAddition(e.target.value)}
                    placeholder="请输入每月定投金额"
                    className={`text-lg h-12 ${darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}`}
                  />
                  <div className="flex gap-2 flex-wrap">
                    {['500', '1000', '2000', '5000'].map((m) => (
                      <Button
                        key={m}
                        variant={monthlyAddition === m ? "default" : "outline"}
                        size="sm"
                        onClick={() => setMonthlyAddition(m)}
                      >
                        ¥{m}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {/* 通胀调整开关 */}
              <div className={`flex items-center justify-between p-4 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-3">
                  <div>
                    <Label htmlFor="inflation" className={`text-base font-medium cursor-pointer ${darkMode ? 'text-white' : ''}`}>
                      通胀调整
                    </Label>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>计算实际购买力</p>
                  </div>
                </div>
                <Switch
                  id="inflation"
                  checked={enableInflation}
                  onCheckedChange={setEnableInflation}
                />
              </div>

              {/* 通胀率输入 */}
              {enableInflation && (
                <div className="space-y-2 animate-in slide-in-from-top-2">
                  <Label htmlFor="inflationRate" className={`text-base font-medium ${darkMode ? 'text-gray-200' : ''}`}>
                    预期通胀率 (%)
                  </Label>
                  <Input
                    id="inflationRate"
                    type="number"
                    step="0.1"
                    value={inflationRate}
                    onChange={(e) => setInflationRate(e.target.value)}
                    placeholder="请输入预期通胀率"
                    className={`text-lg h-12 ${darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}`}
                  />
                  <div className="flex gap-2 flex-wrap">
                    {['2', '3', '4', '5'].map((i) => (
                      <Button
                        key={i}
                        variant={inflationRate === i ? "default" : "outline"}
                        size="sm"
                        onClick={() => setInflationRate(i)}
                      >
                        {i}%
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {/* 计算按钮 */}
              <div className="space-y-3">
                <Button
                  onClick={() => {
                    calculateCompound();
                    toast.success('计算完成');
                  }}
                  className="w-full h-14 text-lg font-semibold"
                >
                  <Calculator className="w-5 h-5 mr-2" />
                  开始计算
                </Button>
                
                {compareMode && result && (
                  <Button
                    onClick={addToCompare}
                    variant="outline"
                    className="w-full"
                  >
                    <GitCompare className="w-4 h-4 mr-2" />
                    添加到对比列表
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 右侧：结果展示 */}
          <div className="space-y-6">
            {/* 核心结果卡片 */}
            {result && (
              <Card className={`shadow-xl ${darkMode ? 'bg-gradient-to-br from-blue-900 to-indigo-900 border-blue-800' : 'bg-gradient-to-br from-blue-600 to-indigo-700'} text-white`}>
                <CardContent className="p-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="text-center p-4 bg-white/10 rounded-lg">
                      <p className="text-blue-100 text-sm mb-1">最终金额</p>
                      <p className="text-2xl md:text-3xl font-bold">
                        ¥{(result.finalAmount / 10000).toFixed(2)}万
                      </p>
                      <p className="text-blue-100 text-xs mt-1">
                        {formatMoney(result.finalAmount)}
                      </p>
                    </div>
                    <div className="text-center p-4 bg-white/10 rounded-lg">
                      <p className="text-blue-100 text-sm mb-1">总收益</p>
                      <p className="text-2xl md:text-3xl font-bold text-green-300">
                        ¥{(result.totalInterest / 10000).toFixed(2)}万
                      </p>
                      <p className="text-blue-100 text-xs mt-1">
                        {formatMoney(result.totalInterest)}
                      </p>
                    </div>
                    <div className="text-center p-4 bg-white/10 rounded-lg">
                      <p className="text-blue-100 text-sm mb-1">投入本金</p>
                      <p className="text-xl font-semibold">
                        ¥{(result.totalPrincipal / 10000).toFixed(2)}万
                      </p>
                    </div>
                    <div className="text-center p-4 bg-white/10 rounded-lg">
                      <p className="text-blue-100 text-sm mb-1">收益率</p>
                      <p className="text-xl font-semibold text-green-300">
                        {((result.totalInterest / result.totalPrincipal) * 100).toFixed(2)}%
                      </p>
                    </div>
                  </div>

                  {/* 利率详细信息 */}
                  <div className="mt-4 p-4 bg-white/10 rounded-lg">
                    <p className="text-sm font-medium text-blue-100 mb-3">📊 利率换算</p>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-blue-200 text-xs">年利率</p>
                        <p className="font-semibold">{result.rate.toFixed(2)}%</p>
                      </div>
                      <div>
                        <p className="text-blue-200 text-xs">月利率</p>
                        <p className="font-semibold">{(result.rate / 12).toFixed(4)}%</p>
                      </div>
                      <div>
                        <p className="text-blue-200 text-xs">周利率</p>
                        <p className="font-semibold">{(result.rate / 52).toFixed(4)}%</p>
                      </div>
                      <div>
                        <p className="text-blue-200 text-xs">日利率</p>
                        <p className="font-semibold">{(result.rate / 365).toFixed(4)}%</p>
                      </div>
                    </div>
                  </div>

                  {enableInflation && (
                    <div className="mt-4 p-4 bg-amber-500/20 border border-amber-400/30 rounded-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <TrendingDown className="w-4 h-4 text-amber-300" />
                        <p className="text-sm font-medium text-amber-100">通胀调整后的实际购买力</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <p className="text-amber-200">名义金额</p>
                          <p className="font-semibold">{formatMoney(result.finalAmount)}</p>
                        </div>
                        <div>
                          <p className="text-amber-200">实际价值</p>
                          <p className="font-semibold text-amber-300">
                            {formatMoney(calculateWithInflation(result.finalAmount, result.years))}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-3 mt-6">
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onClick={saveToHistory}
                    >
                      <Save className="w-4 h-4 mr-2" />
                      保存
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onClick={shareResult}
                    >
                      <Share2 className="w-4 h-4 mr-2" />
                      分享
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onClick={exportReport}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      导出
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 图表区域 */}
            {result && (
              <Tabs defaultValue="trend" className="w-full">
                <TabsList className={`grid w-full grid-cols-2 ${darkMode ? 'bg-gray-800' : ''}`}>
                  <TabsTrigger value="trend" className={darkMode ? 'data-[state=active]:bg-gray-700' : ''}>收益趋势</TabsTrigger>
                  <TabsTrigger value="composition" className={darkMode ? 'data-[state=active]:bg-gray-700' : ''}>收益构成</TabsTrigger>
                </TabsList>
                
                <TabsContent value="trend">
                  <Card className={`shadow-lg ${darkMode ? 'bg-gray-800 border-gray-700' : ''}`}>
                    <CardHeader>
                      <CardTitle className={`text-lg ${darkMode ? 'text-white' : ''}`}>财富增长趋势</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ResponsiveContainer width="100%" height={250}>
                        <AreaChart data={result.yearlyData}>
                          <defs>
                            <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#374151' : undefined} />
                          <XAxis 
                            dataKey="year" 
                            tickFormatter={(value) => `第${value}年`}
                            stroke={darkMode ? '#9ca3af' : undefined}
                          />
                          <YAxis 
                            tickFormatter={(value) => `¥${(value / 10000).toFixed(0)}万`}
                            stroke={darkMode ? '#9ca3af' : undefined}
                          />
                          <Tooltip 
                            formatter={(value: number) => formatMoney(value)}
                            labelFormatter={(label) => `第${label}年`}
                            contentStyle={darkMode ? { backgroundColor: '#1f2937', border: '1px solid #374151' } : undefined}
                          />
                          <Area
                            type="monotone"
                            dataKey="total"
                            stroke="#3b82f6"
                            fillOpacity={1}
                            fill="url(#colorTotal)"
                            name="总资产"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                </TabsContent>
                
                <TabsContent value="composition">
                  <Card className={`shadow-lg ${darkMode ? 'bg-gray-800 border-gray-700' : ''}`}>
                    <CardHeader>
                      <CardTitle className={`text-lg ${darkMode ? 'text-white' : ''}`}>收益构成分析</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 gap-4">
                        <ResponsiveContainer width="100%" height={200}>
                          <PieChart>
                            <Pie
                              data={[
                                { name: '本金', value: result.totalPrincipal },
                                { name: '收益', value: result.totalInterest }
                              ]}
                              cx="50%"
                              cy="50%"
                              innerRadius={40}
                              outerRadius={80}
                              paddingAngle={5}
                              dataKey="value"
                            >
                              <Cell fill="#3b82f6" />
                              <Cell fill="#10b981" />
                            </Pie>
                            <Tooltip 
                              formatter={(value: number) => formatMoney(value)} 
                              contentStyle={darkMode ? { backgroundColor: '#1f2937', border: '1px solid #374151' } : undefined}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="flex flex-col justify-center space-y-3">
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-blue-500 rounded"></div>
                            <span className={`text-sm ${darkMode ? 'text-gray-200' : ''}`}>本金: {formatMoney(result.totalPrincipal)}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-green-500 rounded"></div>
                            <span className={`text-sm ${darkMode ? 'text-gray-200' : ''}`}>收益: {formatMoney(result.totalInterest)}</span>
                          </div>
                          <div className={`pt-2 border-t ${darkMode ? 'border-gray-700' : ''}`}>
                            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                              收益占比: {((result.totalInterest / result.finalAmount) * 100).toFixed(2)}%
                            </p>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            )}

            {/* 复利说明 */}
            <Card className={`shadow-lg ${darkMode ? 'bg-amber-900/30 border-amber-800' : 'bg-amber-50 border-amber-200'}`}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Info className={`w-5 h-5 ${darkMode ? 'text-amber-400' : 'text-amber-600'} mt-0.5 flex-shrink-0`} />
                  <div>
                    <p className={`font-medium ${darkMode ? 'text-amber-100' : 'text-amber-900'} mb-1`}>什么是复利？</p>
                    <p className={`text-sm ${darkMode ? 'text-amber-200' : 'text-amber-800'}`}>
                      复利是指利息也计入本金产生新的利息，俗称"利滚利"。爱因斯坦曾说："复利是世界第八大奇迹"。
                      长期坚持投资，复利效应会让你的财富呈指数级增长。
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* 方案对比区域 */}
        {compareMode && compareResults.length > 0 && (
          <Card className={`mt-6 shadow-xl ${darkMode ? 'bg-gray-800 border-gray-700' : ''}`}>
            <CardHeader>
              <CardTitle className={`flex items-center gap-2 ${darkMode ? 'text-white' : ''}`}>
                <GitCompare className="w-5 h-5 text-blue-600" />
                方案对比 ({compareResults.length}/3)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className={`w-full ${darkMode ? 'text-gray-200' : ''}`}>
                  <thead>
                    <tr className={`border-b ${darkMode ? 'border-gray-700' : ''}`}>
                      <th className={`text-left py-3 px-4 ${darkMode ? 'text-gray-300' : ''}`}>方案</th>
                      <th className="text-right py-3 px-4">本金</th>
                      <th className="text-right py-3 px-4">年利率</th>
                      <th className="text-right py-3 px-4">年限</th>
                      <th className="text-right py-3 px-4">定投</th>
                      <th className="text-right py-3 px-4">最终金额</th>
                      <th className="text-right py-3 px-4">总收益</th>
                      <th className="text-right py-3 px-4">收益率</th>
                      <th className="text-center py-3 px-4">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareResults.map((item, index) => (
                      <tr key={item.id} className={`border-b ${darkMode ? 'border-gray-700 hover:bg-gray-700' : 'hover:bg-gray-50'}`}>
                        <td className="py-3 px-4 font-medium">方案 {index + 1}</td>
                        <td className="text-right py-3 px-4">¥{item.principal.toLocaleString()}</td>
                        <td className="text-right py-3 px-4">{item.rate}%</td>
                        <td className="text-right py-3 px-4">{item.years}年</td>
                        <td className="text-right py-3 px-4">
                          {item.monthlyAddition ? `¥${item.monthlyAddition}` : '-'}
                        </td>
                        <td className={`text-right py-3 px-4 font-semibold ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                          {formatMoney(item.finalAmount)}
                        </td>
                        <td className={`text-right py-3 px-4 ${darkMode ? 'text-green-400' : 'text-green-600'}`}>
                          {formatMoney(item.totalInterest)}
                        </td>
                        <td className="text-right py-3 px-4">
                          {((item.totalInterest / item.totalPrincipal) * 100).toFixed(2)}%
                        </td>
                        <td className="text-center py-3 px-4">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeFromCompare(item.id)}
                          >
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              
              {/* 对比图表 */}
              <div className="mt-6">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={compareResults.map((item, index) => ({
                    name: `方案${index + 1}`,
                    本金: item.totalPrincipal,
                    收益: item.totalInterest,
                    总额: item.finalAmount
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" stroke={darkMode ? '#9ca3af' : undefined} />
                    <YAxis stroke={darkMode ? '#9ca3af' : undefined} tickFormatter={(value) => `¥${(value / 10000).toFixed(0)}万`} />
                    <Tooltip formatter={(value: number) => formatMoney(value)} />
                    <Legend />
                    <Bar dataKey="本金" fill="#3b82f6" />
                    <Bar dataKey="收益" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 多目标计划功能 */}
        <Card className={`mt-6 shadow-xl ${darkMode ? 'bg-gray-800 border-gray-700' : ''}`}>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className={`flex items-center gap-2 ${darkMode ? 'text-white' : ''}`}>
                <Target className="w-5 h-5 text-blue-600" />
                目标计划
              </CardTitle>
              <Button size="sm" onClick={addPlan}>
                新增计划
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {plans.map((plan) => (
                <div key={plan.id} className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={activePlanId === plan.id ? 'default' : 'outline'}
                    onClick={() => setActivePlanId(plan.id)}
                  >
                    {plan.name}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => removePlan(plan.id)}
                    title="删除计划"
                  >
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                </div>
              ))}
            </div>

            {activePlan && activePlanMetrics && (
              <>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className={darkMode ? 'text-gray-200' : ''}>计划名称</Label>
                    <Input
                      value={activePlan.name}
                      onChange={(event) => updateActivePlan({ name: event.target.value })}
                      className={darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className={darkMode ? 'text-gray-200' : ''}>截至日期</Label>
                    <Input
                      type="date"
                      value={activePlan.deadline}
                      onChange={(event) => updateActivePlan({ deadline: event.target.value })}
                      className={darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className={darkMode ? 'text-gray-200' : ''}>目标金额 (¥)</Label>
                    <Input
                      type="number"
                      value={activePlan.targetAmount}
                      onChange={(event) => updateActivePlan({ targetAmount: parseFloat(event.target.value) || 0 })}
                      className={darkMode ? 'bg-gray-700 text-white border-gray-600 placeholder:text-gray-300' : ''}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className={darkMode ? 'text-gray-200' : ''}>当前金额 (¥)</Label>
                    <Input
                      type="number"
                      value={activePlan.currentAmount}
                      onChange={(event) => updateActivePlan({ currentAmount: parseFloat(event.target.value) || 0 })}
                      className={darkMode ? 'bg-gray-700 text-white border-gray-600 placeholder:text-gray-300' : ''}
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label className={darkMode ? 'text-gray-200' : ''}>预期年化利率 (%)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={activePlan.expectedRate}
                      onChange={(event) => updateActivePlan({ expectedRate: parseFloat(event.target.value) || 0 })}
                      className={darkMode ? 'bg-gray-700 text-white border-gray-600 placeholder:text-gray-300' : ''}
                    />
                  </div>
                </div>

                <div className={`p-4 rounded-lg border ${darkMode ? 'bg-gray-900/40 border-gray-700' : 'bg-slate-50 border-slate-200'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <p className={`font-medium ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>中间金额变化</p>
                    <Button size="sm" variant="outline" onClick={addAdjustment}>添加变化</Button>
                  </div>
                  {activePlan.adjustments.length === 0 ? (
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>暂无中间变化，点击“添加变化”可录入某一天的额外投入或支出（支持负数）。</p>
                  ) : (
                    <div className="space-y-3">
                      {activePlan.adjustments.map((adjustment) => (
                        <div key={adjustment.id} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
                          <Input
                            type="date"
                            value={adjustment.date}
                            onChange={(event) => updateAdjustment(adjustment.id, { date: event.target.value })}
                            className={darkMode ? 'bg-gray-700 text-white border-gray-600' : ''}
                          />
                          <Input
                            type="number"
                            value={adjustment.amount}
                            onChange={(event) => updateAdjustment(adjustment.id, { amount: parseFloat(event.target.value) || 0 })}
                            placeholder="金额（负数表示支出）"
                            className={darkMode ? 'bg-gray-700 text-white border-gray-600 placeholder:text-gray-300' : ''}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => removeAdjustment(adjustment.id)}
                            className="md:w-10"
                          >
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
                  <Card className={darkMode ? 'bg-gray-900/40 border-gray-700' : ''}>
                    <CardContent className="p-4">
                      <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>剩余时间</p>
                      <p className={`text-lg font-semibold ${darkMode ? 'text-white' : ''}`}>{activePlanMetrics.daysRemaining} 天</p>
                      <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>{activePlanMetrics.yearsRemaining.toFixed(2)} 年</p>
                    </CardContent>
                  </Card>
                  <Card className={darkMode ? 'bg-gray-900/40 border-gray-700' : ''}>
                    <CardContent className="p-4">
                      <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>预计可达金额</p>
                      <p className={`text-lg font-semibold ${darkMode ? 'text-white' : ''}`}>{formatMoney(activePlanMetrics.projectedWithoutRegularSaving)}</p>
                      <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>当前+中间变化按预期利率增长</p>
                    </CardContent>
                  </Card>
                  <Card className={darkMode ? 'bg-gray-900/40 border-gray-700' : ''}>
                    <CardContent className="p-4">
                      <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>剩余资金缺口</p>
                      <p className={`text-lg font-semibold ${activePlanMetrics.fundingGap > 0 ? 'text-amber-500' : 'text-green-500'}`}>
                        {formatMoney(activePlanMetrics.fundingGap)}
                      </p>
                      <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>目标 - 预计可达</p>
                    </CardContent>
                  </Card>
                  <Card className={darkMode ? 'bg-gray-900/40 border-gray-700' : ''}>
                    <CardContent className="p-4">
                      <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>每年需存</p>
                      <p className={`text-lg font-semibold ${darkMode ? 'text-white' : ''}`}>{formatMoney(activePlanMetrics.yearlySaving)}</p>
                    </CardContent>
                  </Card>
                  <Card className={darkMode ? 'bg-gray-900/40 border-gray-700' : ''}>
                    <CardContent className="p-4">
                      <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>每月需存</p>
                      <p className={`text-lg font-semibold ${darkMode ? 'text-white' : ''}`}>{formatMoney(activePlanMetrics.monthlySaving)}</p>
                    </CardContent>
                  </Card>
                  <Card className={darkMode ? 'bg-gray-900/40 border-gray-700' : ''}>
                    <CardContent className="p-4">
                      <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>每日需存</p>
                      <p className={`text-lg font-semibold ${darkMode ? 'text-white' : ''}`}>{formatMoney(activePlanMetrics.dailySaving)}</p>
                    </CardContent>
                  </Card>
                </div>

                <div className={`p-4 rounded-lg border ${darkMode ? 'bg-indigo-900/20 border-indigo-800' : 'bg-indigo-50 border-indigo-200'}`}>
                  <p className={`text-sm ${darkMode ? 'text-indigo-200' : 'text-indigo-700'}`}>
                    若不再定期存钱，仅靠当前金额和中间变化，要达到目标所需年化利率：
                    <span className="font-semibold ml-1">
                      {activePlanMetrics.requiredAnnualRate === null ? '超过 200%（当前参数不可达）' : `${activePlanMetrics.requiredAnnualRate.toFixed(2)}%`}
                    </span>
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* 详细数据表格 */}
        {result && result.yearlyData.length > 0 && (
          <Card className={`mt-6 shadow-xl ${darkMode ? 'bg-gray-800 border-gray-700' : ''}`}>
            <CardHeader>
              <CardTitle className={`flex items-center gap-2 ${darkMode ? 'text-white' : ''}`}>
                逐年收益明细
                <span className={`text-sm font-normal ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  (共{result.years}年)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className={`border-b ${darkMode ? 'border-gray-700' : ''}`}>
                      <th className={`text-left py-3 px-4 ${darkMode ? 'text-gray-300' : ''}`}>年份</th>
                      <th className={`text-right py-3 px-4 ${darkMode ? 'text-gray-300' : ''}`}>本金累计</th>
                      <th className={`text-right py-3 px-4 ${darkMode ? 'text-gray-300' : ''}`}>收益累计</th>
                      <th className={`text-right py-3 px-4 ${darkMode ? 'text-gray-300' : ''}`}>总资产</th>
                      <th className={`text-right py-3 px-4 ${darkMode ? 'text-gray-300' : ''}`}>当年收益</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.yearlyData.filter((_, i) => i % Math.ceil(result.yearlyData.length / 10) === 0 || i === result.yearlyData.length - 1).map((data, index) => {
                      const prevData = index > 0 ? result.yearlyData[index - 1] : null;
                      const yearlyInterest = prevData ? data.interest - prevData.interest : 0;
                      return (
                        <tr key={data.year} className={`border-b ${darkMode ? 'border-gray-700 hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50'}`}>
                          <td className="py-3 px-4">第{data.year}年</td>
                          <td className="text-right py-3 px-4">{formatMoney(data.principal)}</td>
                          <td className={`text-right py-3 px-4 ${darkMode ? 'text-green-400' : 'text-green-600'}`}>{formatMoney(data.interest)}</td>
                          <td className="text-right py-3 px-4 font-semibold">{formatMoney(data.total)}</td>
                          <td className={`text-right py-3 px-4 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                            {data.year > 0 ? formatMoney(yearlyInterest) : '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 页脚 */}
        <footer className={`mt-8 text-center text-sm pb-8 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          <p>© 2026 复利计算器 - 让财富滚雪球</p>
          <p className="mt-1">本工具仅供参考，不构成投资建议</p>
        </footer>
      </div>
    </div>
  );
}
