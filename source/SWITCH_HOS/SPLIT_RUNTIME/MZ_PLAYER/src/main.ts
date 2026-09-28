import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.44.0').catch(reportFatal);

