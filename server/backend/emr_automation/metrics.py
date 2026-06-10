"""
Metrics and observability utilities for EMR Automation.
"""

from __future__ import annotations

import functools
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, TypeVar

F = TypeVar('F', bound=Callable[..., Any])


@dataclass
class OperationMetric:
    """Represents a single operation's timing data."""
    operation_name: str
    start_time: datetime
    end_time: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    success: bool = True
    error_message: Optional[str] = None


@dataclass
class MetricsCollector:
    """
    Collects and reports operation metrics.
    
    Usage:
        collector = MetricsCollector()
        
        @collector.track
        def my_operation():
            ...
        
        # Or manually:
        with collector.measure("operation_name"):
            ...
        
        # Get stats:
        collector.get_summary()
    """
    operations: List[OperationMetric] = field(default_factory=list)
    _logger: Optional[logging.Logger] = None
    
    @property
    def logger(self) -> logging.Logger:
        if self._logger is None:
            self._logger = logging.getLogger('emr_automation.metrics')
        return self._logger
    
    def track(self, func: F) -> F:
        """
        Decorator to track function execution time.
        
        Args:
            func: Function to track
            
        Returns:
            Wrapped function with timing
        """
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            metric = OperationMetric(
                operation_name=func.__name__,
                start_time=datetime.now(),
            )
            start = time.perf_counter()
            
            try:
                result = func(*args, **kwargs)
                metric.success = True
                return result
            except Exception as e:
                metric.success = False
                metric.error_message = str(e)
                raise
            finally:
                metric.end_time = datetime.now()
                metric.duration_seconds = time.perf_counter() - start
                self.operations.append(metric)
                
                self.logger.debug(
                    f"Operation {metric.operation_name}: "
                    f"{'OK' if metric.success else 'FAILED'} "
                    f"in {metric.duration_seconds:.2f}s"
                )
        
        return wrapper  # type: ignore
    
    def measure(self, operation_name: str):
        """
        Context manager for measuring operation duration.
        
        Args:
            operation_name: Name to identify this operation
        """
        return _MetricsContext(self, operation_name)
    
    def get_summary(self) -> Dict[str, Any]:
        """
        Get a summary of all tracked operations.
        
        Returns:
            Dictionary with operation statistics
        """
        if not self.operations:
            return {"total_operations": 0}
        
        by_name: Dict[str, List[OperationMetric]] = defaultdict(list)
        for op in self.operations:
            by_name[op.operation_name].append(op)
        
        summary: Dict[str, Any] = {
            "total_operations": len(self.operations),
            "success_count": sum(1 for op in self.operations if op.success),
            "failure_count": sum(1 for op in self.operations if not op.success),
            "operations": {},
        }
        
        for name, ops in by_name.items():
            durations = [op.duration_seconds for op in ops if op.duration_seconds is not None]
            summary["operations"][name] = {
                "count": len(ops),
                "success_rate": sum(1 for op in ops if op.success) / len(ops) * 100,
                "avg_duration_seconds": sum(durations) / len(durations) if durations else 0,
                "min_duration_seconds": min(durations) if durations else 0,
                "max_duration_seconds": max(durations) if durations else 0,
            }
        
        return summary
    
    def reset(self) -> None:
        """Clear all collected metrics."""
        self.operations.clear()
    
    def log_summary(self) -> None:
        """Log a summary of all operations."""
        summary = self.get_summary()
        
        self.logger.info("=== Metrics Summary ===")
        self.logger.info(f"Total operations: {summary['total_operations']}")
        self.logger.info(f"Success: {summary['success_count']}, Failures: {summary['failure_count']}")
        
        for name, stats in summary.get("operations", {}).items():
            self.logger.info(
                f"  {name}: {stats['count']} calls, "
                f"{stats['success_rate']:.1f}% success, "
                f"avg {stats['avg_duration_seconds']:.2f}s"
            )


class _MetricsContext:
    """Context manager helper for MetricsCollector.measure()."""
    
    def __init__(self, collector: MetricsCollector, operation_name: str):
        self.collector = collector
        self.operation_name = operation_name
        self.metric: Optional[OperationMetric] = None
        self.start_time: float = 0
    
    def __enter__(self) -> _MetricsContext:
        self.metric = OperationMetric(
            operation_name=self.operation_name,
            start_time=datetime.now(),
        )
        self.start_time = time.perf_counter()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        if self.metric:
            self.metric.end_time = datetime.now()
            self.metric.duration_seconds = time.perf_counter() - self.start_time
            self.metric.success = exc_type is None
            if exc_val:
                self.metric.error_message = str(exc_val)
            self.collector.operations.append(self.metric)
        return False  # Don't suppress exceptions


# Global metrics collector instance
default_metrics = MetricsCollector()


def tracked(func: F) -> F:
    """
    Convenience decorator using the global metrics collector.
    
    Example:
        @tracked
        def my_operation():
            ...
    """
    return default_metrics.track(func)
