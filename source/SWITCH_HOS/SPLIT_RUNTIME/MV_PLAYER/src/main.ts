import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.62.0').catch(reportFatal);

